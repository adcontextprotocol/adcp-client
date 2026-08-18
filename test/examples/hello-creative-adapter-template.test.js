/**
 * CI gates for `examples/hello_creative_adapter_template.ts`.
 *
 * Three independent assertions via the shared helper:
 *   1. The example typechecks under the strictest realistic adopter config.
 *   2. With the published creative-template mock as upstream, the storyboard
 *      runner reports zero failed steps.
 *   3. After the run, every expected upstream route shows ≥1 hit at
 *      /_debug/traffic — the façade-resistance gate.
 */

const path = require('node:path');
const assert = require('node:assert/strict');
const { runHelloAdapterGates } = require('./_helpers/runHelloAdapterGates');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const AUDIO_TEST_KIT = path.join(REPO_ROOT, 'test', 'fixtures', 'acme-outdoor-audio.yaml');

function assertAudioStoryboardRan(grader) {
  const scenarios = (grader.tracks ?? []).flatMap(track => track.scenarios ?? []);

  const capabilityStep = scenarios
    .flatMap(scenario => scenario.steps ?? [])
    .find(step => step.step_id === 'get_capabilities' || step.task === 'get_adcp_capabilities');
  const formats = capabilityStep?.observation_data?.creative?.supported_formats;
  assert.ok(Array.isArray(formats), 'capability discovery did not advertise creative.supported_formats');
  assert.ok(
    formats.some(
      format =>
        format.capability_id === 'audio_30s' &&
        format.format?.format_kind === 'audio_hosted' &&
        format.operations?.includes('build')
    ),
    'creative.supported_formats did not advertise the canonical audio_30s output contract'
  );

  const audioScenario = scenarios.find(scenario => scenario.scenario === 'creative_template/audio_build');
  assert.ok(audioScenario, 'audio-enabled creative_template storyboard did not run the audio_build scenario');
  assert.equal(audioScenario.overall_passed, true, 'creative_template/audio_build scenario did not pass');

  const buildStep = audioScenario.steps?.find(step => step.task === 'build_creative');
  assert.ok(buildStep, 'audio_build scenario did not include a build_creative step');
  assert.notEqual(buildStep.skipped, true, 'build_audio_creative step was skipped');
  assert.equal(buildStep.passed, true, 'build_audio_creative step did not pass');

  const asset = buildStep.observation_data?.creative_manifest?.assets?.audio_main;
  assert.equal(asset?.asset_type, 'audio', 'build_audio_creative did not satisfy the advertised audio_main slot');
  assert.ok(asset?.url, 'audio_main asset did not include a URL');
  const audioUrl = new URL(asset.url);
  assert.match(audioUrl.protocol, /^https?:$/, 'audio serving_tag asset URL was not HTTP(S)');
}

runHelloAdapterGates({
  suiteName: 'examples/hello_creative_adapter_template',
  exampleFile: path.join(REPO_ROOT, 'examples', 'hello_creative_adapter_template.ts'),
  specialism: 'creative-template',
  storyboardId: 'creative_template',
  adcpAuthToken: 'sk_harness_do_not_use_in_prod',
  mockOptions: { apiKey: 'mock_creative_template_key_do_not_use_in_prod' },
  extraEnv: { UPSTREAM_API_KEY: 'mock_creative_template_key_do_not_use_in_prod' },
  expectedRoutes: [
    'GET /_lookup/workspace',
    'GET /v3/workspaces/{ws}/templates',
    'POST /v3/workspaces/{ws}/renders',
    'GET /v3/workspaces/{ws}/renders/{id}',
  ],
  extraStoryboards: [
    {
      id: 'creative_template',
      label: 'passes the audio-enabled creative_template storyboard and exercises audio_build',
      testKitPath: AUDIO_TEST_KIT,
      assertResult: assertAudioStoryboardRan,
    },
  ],
  extraMcpAssertions: [
    {
      label: 'rejects an unadvertised canonical preview target with canonical error attribution',
      run: async ({ callTool }) => {
        const response = await callTool('preview_creative', {
          request_type: 'single',
          target_capability_id: 'upstream_only_template',
          creative_manifest: {
            format_kind: 'image',
            assets: {
              image: {
                asset_type: 'image',
                url: 'https://test-assets.adcontextprotocol.org/acme-outdoor/banner_300x250.jpg',
                width: 300,
                height: 250,
              },
            },
          },
        });
        assert.equal(response?.structuredContent?.adcp_error?.code, 'FORMAT_NOT_SUPPORTED', JSON.stringify(response));
        assert.equal(response?.structuredContent?.adcp_error?.field, 'target_capability_id', JSON.stringify(response));
      },
    },
    {
      label: 'routes legacy preview by the top-level format_id selector',
      run: async ({ agentUrl, callTool }) => {
        const response = await callTool('preview_creative', {
          adcp_version: '3.1',
          request_type: 'single',
          format_id: { agent_url: agentUrl, id: 'display_300x250' },
          creative_manifest: {
            format_id: { agent_url: agentUrl, id: 'display_728x90' },
            assets: {
              image: {
                asset_type: 'image',
                url: 'https://test-assets.adcontextprotocol.org/acme-outdoor/banner_300x250.jpg',
                width: 300,
                height: 250,
              },
            },
          },
        });
        const dimensions = response?.structuredContent?.previews?.[0]?.renders?.[0]?.dimensions;
        assert.deepEqual(dimensions, { width: 300, height: 250 }, JSON.stringify(response));

        const manifestOnly = await callTool('preview_creative', {
          adcp_version: '3.1',
          request_type: 'single',
          creative_manifest: {
            format_id: { agent_url: agentUrl, id: 'display_728x90' },
            assets: {
              image: {
                asset_type: 'image',
                url: 'https://test-assets.adcontextprotocol.org/acme-outdoor/banner_728x90.jpg',
                width: 728,
                height: 90,
              },
            },
          },
        });
        const manifestOnlyDimensions = manifestOnly?.structuredContent?.previews?.[0]?.renders?.[0]?.dimensions;
        assert.deepEqual(manifestOnlyDimensions, { width: 728, height: 90 }, JSON.stringify(manifestOnly));
      },
    },
  ],
});
