export function isPullRequestEvent(eventName: string): boolean {
  return eventName === 'pull_request' || eventName === 'pull_request_target'
}
