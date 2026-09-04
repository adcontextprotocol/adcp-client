import { supportsScenario, type ControllerCapabilities } from './test-controller';

const controllerWithExtension: ControllerCapabilities = {
  detected: true,
  scenarios: ['force_creative_status', 'vendor_reset_fixture'],
};

// Canonical names retain autocomplete through ControllerScenario, while the
// protocol boundary accepts extension names that this SDK does not know yet.
void supportsScenario(controllerWithExtension, 'force_creative_status');
void supportsScenario(controllerWithExtension, 'vendor_reset_fixture');
