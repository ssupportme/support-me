import app from "./app";
import { assertRequiredEnv, validateConfig } from "./config";
import { sorobanEventListener } from "./services/sorobanEventListener";
import { subscriptionExecutor } from "./services/subscriptionExecutor";
import { goalResetScheduler } from "./services/goalResetScheduler";

validateConfig();

const port = process.env.PORT ?? 4000;

// Fail before binding a port if a required secret is missing, so a
// misconfigured deployment never serves traffic with a weak or absent
// signing key (#178).
assertRequiredEnv();

app.listen(port, () => {
  console.log(`SupportMe backend listening on http://localhost:${port}`);
  sorobanEventListener.start();
  subscriptionExecutor.start();
  goalResetScheduler.start();
});
