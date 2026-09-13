import { useNavigate } from 'react-router-dom';
import { createConsoleHeaderAction } from '../console/shell/headerAction';
import type { GuideId } from './catalog';
import { deferNextWelcome } from './guideSession';

const destinations = {
  'model-setup': '/preferences?sect=ai',
  'getting-started': '/console',
  browser: '/browser',
  extensions: '/market?view=marketplace&kind=skill',
  messaging: '/messaging',
  templates: '/console',
  mcp: '/market?view=marketplace&kind=mcp',
  proxy: '/preferences?sect=proxy',
  image: '/preferences?sect=image',
  agents: '/agents',
} satisfies Record<GuideId, string>;

/** Shared by automatic introductions and settings replay. Only opens UI; never starts work. */
export function useGuideAction(id: GuideId) {
  const navigate = useNavigate();
  return {
    actionKey: id === 'model-setup' ? 'guides.configure' : 'guides.tryIt',
    onAction: () => {
      if (id === 'model-setup') deferNextWelcome();
      if (id === 'getting-started' || id === 'templates') {
        navigate(destinations[id], {
          state: {
            consoleAction: createConsoleHeaderAction({
              kind: id === 'templates' ? 'newTemplate' : 'newChat',
            }),
          },
        });
      } else {
        navigate(destinations[id]);
      }
    },
  };
}
