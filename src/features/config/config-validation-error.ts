import type { ConfigValidationIssue } from '../../../shared/types/config';
import {
  messageText,
  PresentationError,
  rawText,
  type PresentationText,
} from '../../i18n/presentationText';

/** Preserve configuration diagnostics while presenting known errors in the current locale. */
export class ConfigValidationError extends PresentationError {
  readonly code: string;

  constructor(
    readonly domain: string,
    readonly issues: readonly ConfigValidationIssue[],
  ) {
    super(presentIssues(issues));
    this.name = 'ConfigValidationError';
    this.code = issues[0]?.code ?? 'CONFIG_VALIDATION_FAILED';
    this.message = issues.map(diagnosticText).join('\n');
  }
}

function presentIssues(issues: readonly ConfigValidationIssue[]): PresentationText {
  return issues.map(presentIssue).reduce<PresentationText | undefined>(
    (first, rest) => first
      ? messageText('configValidation.issueList', { first, rest })
      : rest,
    undefined,
  ) ?? messageText('configValidation.failed');
}

function presentIssue(issue: ConfigValidationIssue): PresentationText {
  if (issue.code === 'INFERENCE_SELECTION_STILL_REFERENCED') {
    return messageText(issue.details?.targetKind === 'provider'
      ? 'configValidation.selectionProviderStillReferenced'
      : 'configValidation.selectionModelStillReferenced');
  }
  return rawText(diagnosticText(issue));
}

function diagnosticText(issue: ConfigValidationIssue): string {
  return `${issue.path || '/'}: ${issue.message}`;
}
