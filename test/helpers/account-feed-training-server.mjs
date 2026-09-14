/**
 * Start the actual upstream training seller, including tenant routing and
 * session persistence. No seller handlers or response data live in the SDK.
 *
 * ADCP_UPSTREAM_CHECKOUT=/path/to/adcp node --import /path/to/adcp/node_modules/tsx/dist/loader.mjs \
 *   test/helpers/account-feed-training-server.mjs
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const checkout = path.resolve(process.env.ADCP_UPSTREAM_CHECKOUT ?? '.context/account-feed/upstream');
const requireUpstream = createRequire(path.join(checkout, 'package.json'));
process.env.NODE_ENV = 'test';
process.env.PUBLIC_TEST_AGENT_TOKEN ??= 'account-feed-local-test-token';
// Upstream locates source schemas relative to its own checkout.
process.chdir(checkout);
const { createTrainingAgentRouter } = await import(
  pathToFileURL(path.join(checkout, 'server/src/training-agent/index.ts')).href
);
const { default: express } = await import(pathToFileURL(requireUpstream.resolve('express')).href);
const { TRAINING_AGENT_CURRENT_ADCP_VERSION: wireVersion } = await import(
  pathToFileURL(path.join(checkout, 'server/src/training-agent/types.ts')).href
);
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use('/api/training-agent', createTrainingAgentRouter());
const listener = app.listen(Number(process.env.ADCP_ACCOUNT_FEED_PORT ?? 4787), '127.0.0.1', () => {
  console.log(
    `ADCP_ACCOUNT_FEED_TRAINING_URL=http://127.0.0.1:${listener.address().port}/api/training-agent/sales/mcp`
  );
  console.log(`ADCP_ACCOUNT_FEED_WIRE_VERSION=${wireVersion}`);
});
