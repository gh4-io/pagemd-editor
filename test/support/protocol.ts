// The one place the e2e specs get the webview protocol number from (T1). It is the host's own constant, so a protocol bump
// no longer breaks twenty specs that each carried a copy; a spec that needs an old number on purpose writes it in the test.
export { PROTOCOL_VERSION as PROTOCOL } from '../../apps/vscode/shared/protocol.ts';
