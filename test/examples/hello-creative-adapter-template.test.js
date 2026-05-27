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

  const formatScenario = scenarios.find(scenario => scenario.scenario === 'creative_template/format_exposure');
  const formats = formatScenario?.steps?.find(
    step => step.step_id === 'discover_formats' || step.task === 'list_creative_formats'
  )?.observation_data?.formats;
  assert.ok(Array.isArray(formats), 'format_exposure did not capture list_creative_formats formats');
  assert.ok(
    formats.some(
      format =>
        format.format_id?.id === 'audio_30s' &&
        format.renders?.some(render => render.parameters_from_format_id === true) &&
        format.assets?.some(asset => asset.asset_id === 'serving_tag' && asset.asset_type === 'audio')
    ),
    'list_creative_formats did not advertise audio_30s with an audio serving_tag output slot'
  );

  const audioScenario = scenarios.find(scenario => scenario.scenario === 'creative_template/audio_build');
  assert.ok(audioScenario, 'audio-enabled creative_template storyboard did not run the audio_build scenario');
  assert.equal(audioScenario.overall_passed, true, 'creative_template/audio_build scenario did not pass');

  const buildStep = audioScenario.steps?.find(step => step.task === 'build_creative');
  assert.ok(buildStep, 'audio_build scenario did not include a build_creative step');
  assert.notEqual(buildStep.skipped, true, 'build_audio_creative step was skipped');
  assert.equal(buildStep.passed, true, 'build_audio_creative step did not pass');

  const asset = buildStep.observation_data?.creative_manifest?.assets?.serving_tag;
  assert.equal(asset?.asset_type, 'audio', 'build_audio_creative did not return an audio serving_tag asset');
  assert.ok(asset?.url, 'audio serving_tag asset did not include a URL');
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
});
