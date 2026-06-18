
import type { ContextConfig, Observation, SessionSummary } from '../types.js';
import { colors } from '../types.js';
import * as Agent from '../formatters/AgentFormatter.js';
import * as Human from '../formatters/HumanFormatter.js';

export function shouldShowSummary(
  config: ContextConfig,
  mostRecentSummary: SessionSummary | undefined,
  mostRecentObservation: Observation | undefined
): boolean {
  if (!config.showLastSummary || !mostRecentSummary) {
    return false;
  }

  const hasContent = !!(
    mostRecentSummary.investigated ||
    mostRecentSummary.learned ||
    mostRecentSummary.completed ||
    mostRecentSummary.next_steps
  );

  if (!hasContent) {
    return false;
  }

  if (mostRecentObservation && mostRecentSummary.created_at_epoch <= mostRecentObservation.created_at_epoch) {
    return false;
  }

  return true;
}

export function renderSummaryFields(
  summary: SessionSummary,
  forHuman: boolean
): string[] {
  const output: string[] = [];

  if (forHuman) {
    output.push(...Human.renderHumanSummaryField('調査', summary.investigated, colors.blue));
    output.push(...Human.renderHumanSummaryField('学び', summary.learned, colors.yellow));
    output.push(...Human.renderHumanSummaryField('完了', summary.completed, colors.green));
    output.push(...Human.renderHumanSummaryField('次の対応', summary.next_steps, colors.magenta));
  } else {
    output.push(...Agent.renderAgentSummaryField('調査', summary.investigated));
    output.push(...Agent.renderAgentSummaryField('学び', summary.learned));
    output.push(...Agent.renderAgentSummaryField('完了', summary.completed));
    output.push(...Agent.renderAgentSummaryField('次の対応', summary.next_steps));
  }

  return output;
}
