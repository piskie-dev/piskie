import { AutoGuide } from './AutoGuide';
import { useModelGuideState } from './useModelGuideState';

export function WelcomeGuide({ historyReady, hasHistory, blocked }: {
  readonly historyReady: boolean;
  readonly hasHistory: boolean;
  readonly blocked: boolean;
}) {
  const model = useModelGuideState();
  return <AutoGuide
    id={model.hasModel ? 'getting-started' : 'model-setup'}
    visitKey="welcome"
    ready={model.ready && (!model.hasModel || historyReady)}
    eligible={!model.hasModel || !hasHistory}
    blocked={blocked}
  />;
}
