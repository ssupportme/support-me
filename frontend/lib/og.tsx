import { ImageResponse } from 'next/og';

// Shared renderer for the generated Open Graph / X (twitter:image) cards.
// 1200x630 satisfies both og:image and X's summary_large_image (2:1-ish,
// min 300x157), so the same image is served for both tags.

export const OG_SIZE = { width: 1200, height: 630 };

const INK = '#0a0a0a';
const PAPER = '#fdfcf7';
const YELLOW = '#ffd84d';
const VIOLET = '#7c3aed';
const PINK = '#ff9db1';

type Font = { name: string; data: ArrayBuffer; weight: 400 | 800; style: 'normal' };

// Geist is the site font. Google Fonts serves TTF to non-browser user agents,
// which is what Satori needs. If the fetch fails we fall back to the bundled
// default font rather than failing the whole image.
async function loadGeist(weight: 400 | 800): Promise<Font | null> {
  try {
    const css = await fetch(`https://fonts.googleapis.com/css2?family=Geist:wght@${weight}`, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; U; Intel Mac OS X 10_6_8; de-at) AppleWebKit/533.21.1 (KHTML, like Gecko) Version/5.0.5 Safari/533.21.1',
      },
      next: { revalidate: 60 * 60 * 24 * 7 },
    }).then((r) => r.text());
    const url = css.match(/src: url\((.+?)\) format\('(?:opentype|truetype)'\)/)?.[1];
    if (!url) return null;
    const data = await fetch(url).then((r) => r.arrayBuffer());
    return { name: 'Geist', data, weight, style: 'normal' };
  } catch {
    return null;
  }
}

async function loadFonts(): Promise<Font[]> {
  const fonts = await Promise.all([loadGeist(400), loadGeist(800)]);
  return fonts.filter((f): f is Font => f !== null);
}

// Remote images that fail to load make Satori throw, so avatars are fetched
// up front and inlined; any failure just drops the avatar.
async function toDataUrl(src: string): Promise<string | null> {
  try {
    const res = await fetch(src);
    if (!res.ok) return null;
    const type = res.headers.get('content-type') || 'image/png';
    if (!/^image\/(png|jpe?g|gif)/.test(type)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

function Wordmark() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
      <div
        style={{
          display: 'flex',
          width: 56,
          height: 56,
          alignItems: 'center',
          justifyContent: 'center',
          background: YELLOW,
          border: `4px solid ${INK}`,
          borderRadius: 12,
          boxShadow: `4px 4px 0 0 ${INK}`,
        }}
      >
        <svg width="34" height="34" viewBox="0 0 24 24">
          <path
            d="M12 20.5s-8-4.7-9.6-9.7C1.3 7.3 3.6 4 7 4c2.1 0 3.8 1.2 5 3 1.2-1.8 2.9-3 5-3 3.4 0 5.7 3.3 4.6 6.8-1.6 5-9.6 9.7-9.6 9.7z"
            fill={VIOLET}
            stroke={INK}
            strokeWidth="2"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <div style={{ fontSize: 40, fontWeight: 800, color: INK, letterSpacing: -1 }}>SupportMe</div>
    </div>
  );
}

function truncate(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export async function renderLandingOgImage() {
  const fonts = await loadFonts();
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: YELLOW,
          padding: 64,
          fontFamily: 'Geist',
        }}
      >
        <Wordmark />
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontSize: 88, fontWeight: 800, color: INK, lineHeight: 1.05, letterSpacing: -3 }}>
            Get Tipped. Get Paid.
          </div>
          <div style={{ marginTop: 24, fontSize: 36, color: INK }}>
            A tipping platform built on Stellar. Supporters send XLM or USDC, you cash out to your bank.
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            alignSelf: 'flex-start',
            background: VIOLET,
            color: '#ffffff',
            border: `4px solid ${INK}`,
            boxShadow: `6px 6px 0 0 ${INK}`,
            padding: '14px 28px',
            fontSize: 30,
            fontWeight: 800,
          }}
        >
          Become a Creator
        </div>
      </div>
    ),
    { ...OG_SIZE, ...(fonts.length ? { fonts } : {}) },
  );
}

export interface OgCreator {
  username: string;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  donationGoal: number | null;
}

export async function renderCreatorOgImage(creator: OgCreator | null) {
  if (!creator) return renderLandingOgImage();

  const name = creator.displayName || creator.username;
  const bio = creator.bio?.trim() || `Support ${name} with a tip on SupportMe.`;
  const [avatar, fonts] = await Promise.all([
    creator.avatarUrl ? toDataUrl(creator.avatarUrl) : Promise.resolve(null),
    loadFonts(),
  ]);

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: YELLOW,
          padding: 56,
          fontFamily: 'Geist',
        }}
      >
        <Wordmark />
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 48,
            background: PAPER,
            border: `5px solid ${INK}`,
            boxShadow: `10px 10px 0 0 ${INK}`,
            padding: 44,
          }}
        >
          {avatar ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={avatar}
              width={220}
              height={220}
              alt=""
              style={{ borderRadius: 9999, border: `5px solid ${INK}`, objectFit: 'cover' }}
            />
          ) : (
            <div
              style={{
                display: 'flex',
                width: 220,
                height: 220,
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 9999,
                border: `5px solid ${INK}`,
                background: PINK,
                fontSize: 110,
                fontWeight: 800,
                color: INK,
              }}
            >
              {name.charAt(0).toUpperCase()}
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
            <div style={{ fontSize: 64, fontWeight: 800, color: INK, letterSpacing: -2, lineHeight: 1.1 }}>
              {truncate(name, 28)}
            </div>
            <div style={{ fontSize: 32, color: VIOLET, fontWeight: 800, marginTop: 6 }}>
              {`@${creator.username}`}
            </div>
            <div style={{ fontSize: 30, color: '#57534e', marginTop: 20, lineHeight: 1.3 }}>
              {truncate(bio, 110)}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', fontSize: 30, fontWeight: 800, color: INK }}>
          {creator.donationGoal
            ? `Goal: $${creator.donationGoal.toLocaleString('en-US')} · Send a tip in XLM or USDC →`
            : 'Send a tip in XLM or USDC →'}
        </div>
      </div>
    ),
    { ...OG_SIZE, ...(fonts.length ? { fonts } : {}) },
  );
}
