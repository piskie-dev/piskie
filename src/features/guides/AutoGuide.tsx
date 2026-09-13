import { FeatureGuideDialog } from './FeatureGuideDialog';
import { useAutoGuide, type AutoGuideOptions } from './useAutoGuide';
import { useGuideAction } from './useGuideAction';

export function AutoGuide({ onAction, actionKey, ...options }: AutoGuideOptions & {
  readonly onAction?: () => void;
  readonly actionKey?: string;
}) {
  const guide = useAutoGuide(options);
  const action = useGuideAction(guide.id);
  return <FeatureGuideDialog id={guide.id} open={guide.open} onClose={guide.close} onComplete={guide.complete} onAction={onAction ?? action.onAction} actionKey={actionKey ?? action.actionKey} />;
}
