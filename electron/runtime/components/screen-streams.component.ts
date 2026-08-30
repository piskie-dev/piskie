import type { ScreenStreamService } from '../../services/screen-stream.service.js';
import type { RuntimeComponent } from '../component-manifest.js';

export function createScreenStreamsComponent(
  streams: ScreenStreamService,
): RuntimeComponent<ScreenStreamService> {
  const close = (): void => streams.stop();

  return {
    id: 'screen-streams',
    requirement: 'required',
    dependsOn: ['pilot'],
    async start(_context, scope) {
      scope.register({
        kind: 'stream',
        label: 'window-screen-streams',
        close,
        inspect: () => {
          const snapshot = streams.lifecycleSnapshot();
          return !snapshot.accepting && snapshot.activeStreams.length === 0 ? 'closed' : 'live';
        },
        describe: () => streams.lifecycleSnapshot(),
      });
      streams.start();
      return streams;
    },
    async stop() {
      close();
    },
    async verifyStopped() {
      const snapshot = streams.lifecycleSnapshot();
      return {
        state: !snapshot.accepting && snapshot.activeStreams.length === 0 ? 'stopped' : 'live',
        details: { activeStreams: snapshot.activeStreams },
      };
    },
  };
}
