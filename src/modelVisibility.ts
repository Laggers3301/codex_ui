import {isReclaudeModel} from '../shared/agentRuntime';

function claudeOrganization(model:unknown):string|undefined{
  return isReclaudeModel(model)&&typeof model==='string'?model.match(/@([0-9]+)$/)?.[1]:undefined;
}

/** Presentation only. The backend still verifies the private user/source
 * provenance on every switch and turn; a menu never grants execution rights. */
export function visibleConversationModels<T extends {model:string;restrictedToSourceThreadId?:string}>(
  profiles:T[],thread:{id:string;configuredModel?:string|null;model?:string|null}|null|undefined
):T[]{
  const currentOrganization=claudeOrganization(thread?.configuredModel??thread?.model);
  return profiles.filter(profile=>!profile.restrictedToSourceThreadId
    ||profile.restrictedToSourceThreadId===thread?.id
    ||!!currentOrganization&&claudeOrganization(profile.model)===currentOrganization);
}
