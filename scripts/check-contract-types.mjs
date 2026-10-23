#!/usr/bin/env node
/**
 * Contract type-drift check: keeps the off-chain mirrors of the Soroban
 * contract event surface honest.
 *
 * Source of truth                          Mirrors
 * ---------------------------------        ------------------------------------
 * contracts/donation/src/lib.rs            docs/architecture/contract-events.md
 * contracts/creator-registry/src/lib.rs    backend/src/services/eventBus.ts
 * contracts/common/src/lib.rs              backend/src/services/sorobanEventListener.ts
 *                                          the frontend's SSE payload types
 *
 * This replaces an older shell heuristic that failed a pull request only when
 * `contracts/common/src/lib.rs` changed without any `frontend/*.ts(x)` file also
 * changing. Any unrelated frontend edit satisfied it, and it saw nothing at all
 * when a contract event changed without `lib.rs` being touched. Here the
 * contract sources are parsed and compared field by field, so a renamed, added,
 * or removed field fails unless the mirrors below it are updated in the same
 * commit:
 *
 *   1. every event documented in `contract-events.md` exists in the contracts
 *      with the same topic, the same fields, and the same order — and every
 *      contract event is either documented or listed in `UNMIRRORED_EVENTS`;
 *   2. every field the listener reads, and every topic index it reads, exists
 *      on the event struct;
 *   3. every event field (camelCased) exists on the `eventBus` interface the
 *      listener emits, and that interface declares no field unknown to the
 *      contract (save `TRANSPORT_FIELDS`);
 *   4. every field the frontend declares while parsing an SSE payload exists on
 *      the interface the backend emits it from, and the frontend only listens
 *      for event names `eventBus` actually emits;
 *   5. every shared `contracttype` struct in `contracts/common` that an event
 *      mirrors lines up with that event field for field — through the explicit
 *      `COMMON_MIRRORS` map below, so an undeclared rename/removal/addition
 *      fails, and so does a mapping entry that has gone stale.
 *
 * Deliberately content-based and fail-closed: a source file that no longer
 * parses is an error, not a silent pass.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const EVENT_SOURCES = [
  'contracts/donation/src/lib.rs',
  'contracts/creator-registry/src/lib.rs',
];
const COMMON = 'contracts/common/src/lib.rs';
const DOC = 'docs/architecture/contract-events.md';
const BUS = 'backend/src/services/eventBus.ts';
const LISTENER = 'backend/src/services/sorobanEventListener.ts';
const FRONTEND_DIR = 'frontend/app';

/**
 * Events emitted purely for on-chain tooling and observability: no off-chain
 * consumer reads them, so they have neither a documentation section nor an
 * `eventBus` interface to drift from. Keyed by struct name — a new or renamed
 * event still fails until it is mirrored or listed here.
 */
const UNMIRRORED_EVENTS = new Map([
  ['ProposalCreatedEvent', 'admin proposal lifecycle, not consumed off-chain'],
  ['ProposalApprovedEvent', 'admin proposal lifecycle, not consumed off-chain'],
  ['ProposalExecutedEvent', 'admin proposal lifecycle, not consumed off-chain'],
  ['ProposalCancelledEvent', 'admin proposal lifecycle, not consumed off-chain'],
  ['SubscriptionChargeFailedEvent', 'failed-charge telemetry, not consumed off-chain'],
]);

/**
 * Fields the backend adds when it republishes an on-chain event on `eventBus`:
 * RPC metadata and values derived from the payload, not event fields. Anything
 * else on a bus interface has to come from the contract struct.
 */
const TRANSPORT_FIELDS = new Set(['ledger', 'txHash', 'eventId', 'currency']);

/**
 * Shared `contracttype` structs in `contracts/common` and the event struct that
 * mirrors each one. The three difference lists below are the *entire* declared
 * contract between them, so:
 *
 *   - `renamed`    struct field -> differently-named event field;
 *   - `omitted`    struct fields deliberately not carried by the event;
 *   - `eventOnly`  event fields with no counterpart on the struct.
 *
 * Any struct or event field not covered by one of those lists fails the check,
 * and a listed field that no longer exists in either place also fails (so a
 * stale entry cannot mask a later rename). Changing a shared struct without
 * touching its event mirror therefore cannot pass.
 */
const COMMON_MIRRORS = [
  {
    struct: 'DonationRecord',
    event: 'DonatedEvent',
    renamed: {},
    omitted: [],
    eventOnly: ['donation_id', 'token', 'subscription_id'],
  },
  {
    struct: 'Subscription',
    event: 'SubscribedEvent',
    renamed: {},
    omitted: ['active'],
    eventOnly: ['subscription_id'],
  },
  {
    struct: 'CreatorProfile',
    event: 'DonationRecordedEvent',
    renamed: { address: 'creator' },
    omitted: ['username', 'created_at'],
    eventOnly: ['amount'],
  },
];

const problems = [];
const fail = (message) => problems.push(message);
// Normalise CRLF so the line-oriented parsers below behave the same on a
// Windows checkout as on the Linux CI runner.
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const camel = (name) => name.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const names = (fields) => fields.map((f) => f.name).join(', ');
const list = (items) => [...items].join(', ') || '(none)';

/** `#[contractevent(topics = ["x"])] pub struct X {...}` definitions. */
function parseRustEvents(rel) {
  const src = read(rel);
  const events = [];
  const re =
    /#\[contractevent\(topics\s*=\s*\[([^\]]*)\]\)\][\s\S]*?\npub struct (\w+)\s*\{([\s\S]*?)\n\}/g;

  for (const match of src.matchAll(re)) {
    const topic = match[1].match(/"([^"]+)"/)?.[1];
    if (!topic) throw new Error(`${rel}: #[contractevent] without a topic string`);
    events.push({
      file: rel,
      struct: match[2],
      topic,
      fields: parseRustFields(rel, match[2], match[3]),
    });
  }

  if (events.length === 0) {
    throw new Error(`${rel}: no #[contractevent] structs found — check the parser`);
  }
  return events;
}

function parseRustFields(rel, struct, body) {
  const fields = [];
  let pendingTopic = false;

  for (const raw of body.split('\n')) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    if (line === '#[topic]') {
      pendingTopic = true;
      continue;
    }
    const field = line.match(/^pub (\w+):\s*.+?,?$/);
    if (!field) throw new Error(`${rel}: cannot parse "${line}" in ${struct}`);
    fields.push({ name: field[1], topic: pendingTopic });
    pendingTopic = false;
  }

  if (fields.length === 0) throw new Error(`${rel}: ${struct} declares no fields`);
  return fields;
}

/** `#[contracttype] pub struct X {...}` definitions in `contracts/common`. */
function parseCommonStructs() {
  const src = read(COMMON);
  const structs = new Map();

  for (const match of src.matchAll(/#\[contracttype\]\s*\npub struct (\w+)\s*\{([\s\S]*?)\n\}/g)) {
    const fields = parseRustFields(COMMON, match[1], match[2]).map((f) => f.name);
    structs.set(match[1], fields);
  }

  if (structs.size === 0) {
    throw new Error(`${COMMON}: no #[contracttype] structs found — check the parser`);
  }
  return structs;
}

/** `### 2.x. \`EventName\`` sections: topic schema plus the rust value schema. */
function parseDocEvents() {
  const src = read(DOC);
  const events = new Map();

  for (const section of src.split(/\n### /).slice(1)) {
    const name = section.match(/^[\d.]+\s*`(\w+)`/)?.[1];
    if (!name) continue;

    const topicSchema = section.match(/\*\*Topic Schema\*\*:\s*`([^`]+)`/)?.[1];
    const parsed = topicSchema?.match(/^\["([^"]+)"(.*)\]$/);
    if (!parsed) throw new Error(`${DOC}: cannot parse the topic schema of ${name}`);

    const block = section.match(/```rust\r?\n([\s\S]*?)```/)?.[1];
    if (!block) throw new Error(`${DOC}: ${name} has no rust value schema block`);

    const fields = [];
    for (const raw of block.split('\n')) {
      const line = raw.trim();
      if (/^pub struct /.test(line) || !line.startsWith('pub ')) continue;
      const field = line.match(/^pub (\w+):\s*.+$/);
      if (!field) throw new Error(`${DOC}: cannot parse "${line}" in ${name}`);
      fields.push({ name: field[1], topic: /\/\/\s*\[topic\]/.test(line) });
    }
    if (fields.length === 0) throw new Error(`${DOC}: ${name} documents no fields`);

    events.set(name, { topic: parsed[1], fields });
  }

  if (events.size === 0) throw new Error(`${DOC}: no event sections found — check the parser`);
  return events;
}

/** `export interface XEvent { ... }` payload shapes, and the SSE event names. */
function parseBus() {
  const src = read(BUS);
  const interfaces = new Map();
  const constants = new Map();

  for (const match of src.matchAll(/export interface (\w+)\s*\{([\s\S]*?)\n\}/g)) {
    const fields = [];
    for (const raw of match[2].split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('*') || line.startsWith('/*') || line.startsWith('//')) continue;
      const field = line.match(/^(\w+)\??:/);
      if (field) fields.push(field[1]);
    }
    if (fields.length === 0) throw new Error(`${BUS}: ${match[1]} declares no fields`);
    interfaces.set(match[1], fields);
  }

  for (const match of src.matchAll(/export const (\w+)\s*=\s*"([^"]+)"/g)) {
    constants.set(match[1], match[2]);
  }

  if (interfaces.size === 0 || constants.size === 0) {
    throw new Error(`${BUS}: no interfaces/event names found — check the parser`);
  }
  return { interfaces, constants };
}

/** One entry per `case "topic":` in the listener. */
function parseListenerCases() {
  const src = read(LISTENER);
  const cases = [];

  for (const block of src.matchAll(
    /\n\s*case "([a-z_]+)":\s*\{([\s\S]*?)(?=\n\s*case "|\n\s*default:)/g
  )) {
    const [, topic, body] = block;

    const shape = body.match(/as\s*\{([^}]*)\}/)?.[1];
    if (!shape) throw new Error(`${LISTENER}: case "${topic}" decodes its value untyped`);

    const payloadType = body.match(/const payload:\s*(\w+)\s*=/)?.[1];
    if (!payloadType) throw new Error(`${LISTENER}: case "${topic}" emits an untyped payload`);

    const emit = body.match(/eventBus\.emit\((\w+)/)?.[1];
    if (!emit) throw new Error(`${LISTENER}: case "${topic}" emits no eventBus event`);

    cases.push({
      topic,
      valueFields: [...shape.matchAll(/(\w+)\??:/g)].map((m) => m[1]),
      payloadType,
      emit,
      topicIndexes: [...new Set([...body.matchAll(/topics\[(\d+)\]/g)].map((m) => Number(m[1])))]
        .filter((index) => index > 0)
        .sort((a, b) => a - b),
    });
  }

  if (cases.length === 0) throw new Error(`${LISTENER}: no event cases found — check the parser`);
  return cases;
}

function walk(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else if (/\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found;
}

/**
 * Every `stream.addEventListener('<event>', handler)` on an `EventSource`
 * (matched by receiver, so plain DOM listeners like `document.addEventListener`
 * are left alone) whose handler declares its payload shape.
 */
function parseFrontendSubscriptions() {
  const subscriptions = [];

  for (const file of walk(path.join(ROOT, FRONTEND_DIR))) {
    if (file.includes('__tests__') || /\.test\.tsx?$/.test(file)) continue;
    const src = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const rel = path.relative(ROOT, file).split(path.sep).join('/');

    const streams = new Set(
      [...src.matchAll(/(?:const|let|var)\s+(\w+)\s*(?::[^=]*)?=\s*new EventSource\(/g)].map(
        (match) => match[1]
      )
    );
    if (streams.size === 0) continue;

    for (const match of src.matchAll(/(\w+)\.addEventListener\(\s*'([a-z_]+)'\s*,\s*(\w+)\s*\)/g)) {
      const [, receiver, eventName, handler] = match;
      if (!streams.has(receiver)) continue;

      const definition = src.match(
        new RegExp(`const ${handler}\\s*=\\s*\\([^)]*\\)\\s*=>\\s*\\{`)
      );
      if (!definition) throw new Error(`${rel}: cannot find the "${handler}" handler`);

      const body = src.slice(definition.index, definition.index + 2000);
      const shape = body.match(/(?:let|const) payload:\s*\{([\s\S]*?)\}/)?.[1];
      if (!shape) {
        throw new Error(
          `${rel}: "${handler}" listens for "${eventName}" without declaring the payload type — ` +
            'the drift check needs it to compare field names against the eventBus interface'
        );
      }

      subscriptions.push({
        file: rel,
        eventName,
        handler,
        fields: [...shape.matchAll(/(\w+)\??:/g)].map((m) => m[1]),
      });
    }
  }

  return subscriptions;
}

function compareDocsToContracts(rustEvents, docEvents) {
  for (const event of rustEvents) {
    const documented = docEvents.get(event.struct);
    if (!documented) {
      if (!UNMIRRORED_EVENTS.has(event.struct)) {
        fail(
          `${DOC}: ${event.struct} ("${event.topic}") is emitted by ${event.file} but is not ` +
            'documented. Document it, or add it to UNMIRRORED_EVENTS in this script if no ' +
            'off-chain consumer reads it.'
        );
      }
      continue;
    }

    if (documented.topic !== event.topic) {
      fail(
        `${DOC}: ${event.struct} documents topic "${documented.topic}" but ${event.file} ` +
          `emits "${event.topic}".`
      );
    }
    if (names(documented.fields) !== names(event.fields)) {
      fail(
        `${DOC}: ${event.struct} fields do not match ${event.file}.\n` +
          `    documented: ${names(documented.fields)}\n` +
          `    contract:   ${names(event.fields)}`
      );
    }
    const documentedTopics = names(documented.fields.filter((f) => f.topic));
    const contractTopics = names(event.fields.filter((f) => f.topic));
    if (documentedTopics !== contractTopics) {
      fail(
        `${DOC}: ${event.struct} #[topic] fields do not match ${event.file}.\n` +
          `    documented: ${documentedTopics}\n` +
          `    contract:   ${contractTopics}`
      );
    }
  }

  for (const name of docEvents.keys()) {
    if (!rustEvents.some((event) => event.struct === name)) {
      fail(`${DOC}: documents ${name}, which no contract declares anymore.`);
    }
  }
}

function compareCommonToEvents(commonStructs, rustEvents) {
  for (const mirror of COMMON_MIRRORS) {
    const label = `${COMMON} ${mirror.struct} <-> ${mirror.event}`;
    const structFields = commonStructs.get(mirror.struct);
    if (!structFields) {
      fail(
        `${COMMON}: the mirrored struct ${mirror.struct} no longer exists. Remove the ` +
          `COMMON_MIRRORS entry, or point it at its replacement.`
      );
      continue;
    }
    const event = rustEvents.find((e) => e.struct === mirror.event);
    if (!event) {
      fail(
        `${COMMON}: ${mirror.struct} is mirrored by ${mirror.event}, which no contract ` +
          'declares anymore.'
      );
      continue;
    }

    const structSet = new Set(structFields);
    const eventFields = event.fields.map((f) => f.name);
    const eventSet = new Set(eventFields);
    const renamed = mirror.renamed;
    const omitted = new Set(mirror.omitted);
    const eventOnly = new Set(mirror.eventOnly);

    for (const [from, to] of Object.entries(renamed)) {
      if (!structSet.has(from)) fail(`${label}: renamed "${from}" is not a field of ${mirror.struct}.`);
      if (!eventSet.has(to)) fail(`${label}: renamed target "${to}" is not a field of ${mirror.event}.`);
    }
    for (const field of omitted) {
      if (!structSet.has(field)) fail(`${label}: "${field}" is listed as omitted but ${mirror.struct} no longer declares it.`);
    }
    for (const field of eventOnly) {
      if (!eventSet.has(field)) fail(`${label}: "${field}" is listed as event-only but ${mirror.event} no longer declares it.`);
    }

    for (const field of structFields) {
      const carried = eventSet.has(field) || Object.hasOwn(renamed, field) || omitted.has(field);
      if (!carried) {
        fail(
          `${label}: ${mirror.struct} declares "${field}", which ${mirror.event} neither ` +
            'carries, renames, nor lists as omitted. Mirror the field in the event, or ' +
            'declare the difference in COMMON_MIRRORS.'
        );
      }
    }

    const renameTargets = new Set(Object.values(renamed));
    for (const field of eventFields) {
      const explained =
        structSet.has(field) || renameTargets.has(field) || eventOnly.has(field);
      if (!explained) {
        fail(
          `${label}: ${mirror.event} emits "${field}", which ${mirror.struct} does not ` +
            'declare. Update the shared struct, or declare the difference in COMMON_MIRRORS.'
        );
      }
    }
  }
}

function compareListenerToContracts(rustEvents, cases, interfaces) {
  for (const listenerCase of cases) {
    const event = rustEvents.find((e) => e.topic === listenerCase.topic);
    if (!event) {
      fail(
        `${LISTENER}: handles "${listenerCase.topic}", but no #[contractevent] declares that topic.`
      );
      continue;
    }

    const valueFields = new Set(event.fields.filter((f) => !f.topic).map((f) => f.name));
    for (const field of listenerCase.valueFields) {
      if (!valueFields.has(field)) {
        fail(
          `${LISTENER}: case "${listenerCase.topic}" reads value.${field}, which ${event.file}'s ` +
            `${event.struct} does not declare (value fields: ${list(valueFields)}).`
        );
      }
    }

    const topicFields = event.fields.filter((f) => f.topic).map((f) => f.name);
    for (const index of listenerCase.topicIndexes) {
      if (!topicFields[index - 1]) {
        fail(
          `${LISTENER}: case "${listenerCase.topic}" reads topics[${index}], but ${event.struct} ` +
            `declares only ${topicFields.length} #[topic] field(s).`
        );
      }
    }

    const fields = interfaces.get(listenerCase.payloadType);
    if (!fields) {
      fail(
        `${BUS}: ${listenerCase.payloadType} (emitted for "${listenerCase.topic}") has no ` +
          'exported interface to check against.'
      );
      continue;
    }

    const fromContract = new Set(event.fields.map((f) => camel(f.name)));
    for (const field of fromContract) {
      if (!fields.includes(field)) {
        fail(
          `${BUS}: ${listenerCase.payloadType} is missing "${field}" — ${event.file}'s ` +
            `${event.struct} declares ${[...fromContract].sort().join(', ')}.`
        );
      }
    }
    for (const field of fields) {
      if (!fromContract.has(field) && !TRANSPORT_FIELDS.has(field)) {
        fail(
          `${BUS}: ${listenerCase.payloadType} declares "${field}", which ${event.file}'s ` +
            `${event.struct} does not emit. Drop it, or add it to TRANSPORT_FIELDS in this ` +
            'script if the backend adds it.'
        );
      }
    }
  }
}

function compareFrontendToBus(subscriptions, cases, constants, interfaces) {
  for (const subscription of subscriptions) {
    const listenerCase = cases.find((c) => constants.get(c.emit) === subscription.eventName);
    if (!listenerCase) {
      fail(
        `${subscription.file}: listens for the SSE event "${subscription.eventName}", which no ` +
          `${BUS} constant emits (emitted names: ${list(constants.values())}).`
      );
      continue;
    }

    const fields = interfaces.get(listenerCase.payloadType) ?? [];
    for (const field of subscription.fields) {
      if (!fields.includes(field)) {
        fail(
          `${subscription.file}: "${subscription.handler}" reads "${field}" from the ` +
            `"${subscription.eventName}" payload, but ${BUS}'s ${listenerCase.payloadType} ` +
            `declares ${list(fields)}.`
        );
      }
    }
  }
}

function main() {
  const rustEvents = EVENT_SOURCES.flatMap(parseRustEvents);
  const commonStructs = parseCommonStructs();
  const docEvents = parseDocEvents();
  const { interfaces, constants } = parseBus();
  const cases = parseListenerCases();
  const subscriptions = parseFrontendSubscriptions();

  compareDocsToContracts(rustEvents, docEvents);
  compareCommonToEvents(commonStructs, rustEvents);
  compareListenerToContracts(rustEvents, cases, interfaces);
  compareFrontendToBus(subscriptions, cases, constants, interfaces);

  if (problems.length > 0) {
    console.error(`Contract type drift detected (${problems.length} problem(s)):\n`);
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(
      '\nUpdate the mirror(s) above alongside the contract change — see ' +
        'docs/architecture/contract-events.md.'
    );
    process.exit(1);
  }

  console.log(
    `Contract types in sync: ${rustEvents.length} event struct(s) across ${EVENT_SOURCES.length} ` +
      `contracts, ${commonStructs.size} shared struct(s), ${docEvents.size} documented, ` +
      `${cases.length} consumed by the backend listener, ${subscriptions.length} frontend ` +
      'SSE payload type(s).'
  );
}

main();
