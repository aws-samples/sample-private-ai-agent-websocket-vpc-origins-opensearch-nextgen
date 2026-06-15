/**
 * Stack snapshot tests (split-stack architecture).
 *
 * Captures a full synthesized-template snapshot of each stack to guard against
 * accidental drift in the generated CloudFormation. Regenerate intentionally:
 *
 *   npx jest -u            # update stored snapshots after an intentional change
 *
 * Stacks are synthesized with the documented `testSynth` context flag so they
 * build without Docker (see {@link synthStacks}).
 */
import { synthStacks } from './helpers';

describe('split-stack snapshots', () => {
  test('Network stack template matches the stored snapshot', () => {
    expect(synthStacks().networkTemplate.toJSON()).toMatchSnapshot();
  });

  test('Build stack template matches the stored snapshot', () => {
    expect(synthStacks().buildTemplate.toJSON()).toMatchSnapshot();
  });

  test('Data stack template matches the stored snapshot', () => {
    expect(synthStacks().dataTemplate.toJSON()).toMatchSnapshot();
  });

  test('AgentCore stack template matches the stored snapshot', () => {
    expect(synthStacks().agentTemplate.toJSON()).toMatchSnapshot();
  });

  test('App stack template matches the stored snapshot', () => {
    expect(synthStacks().appTemplate.toJSON()).toMatchSnapshot();
  });
});
