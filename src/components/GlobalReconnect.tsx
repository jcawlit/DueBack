/**
 * The reconnect question, mounted once at the root for the same reason as
 * every other modal here: a navigation stack keeps the screens beneath the
 * current one mounted, so one per screen would mean two on screen at once.
 *
 * Questions are answered one at a time, oldest first. A scan that found three
 * moved books asks three times rather than stacking them.
 */

import { ReconnectSheet } from './ReconnectSheet';
import { useLibrary } from '@/store/library';

export function GlobalReconnect() {
  const questions = useLibrary((s) => s.reconnectQuestions);
  const answerReconnect = useLibrary((s) => s.answerReconnect);
  const first = questions[0] ?? null;

  return (
    <ReconnectSheet
      question={first}
      onAnswer={(candidateId) => {
        if (first) void answerReconnect(first.missingId, candidateId);
      }}
    />
  );
}
