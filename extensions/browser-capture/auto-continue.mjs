// Only a freshly committed success starts this foreground countdown. Restoring
// persisted state never starts a timer. Epochs also invalidate already queued work.
export function createAutoContinue({ onTick, onElapsed, now = () => performance.now(), schedule = setTimeout, unschedule = clearTimeout }) {
  let epoch = 0;
  let active = null;
  let timer = null;
  let visible = true;
  function cancel() {
    epoch++;
    if (timer !== null) unschedule(timer);
    timer = null;
    active = null;
    onTick(null);
  }
  function tick() {
    if (!active || !visible) return;
    active.remaining = Math.max(0, active.deadline - now());
    if (active.remaining === 0) {
      const identity = active.identity;
      active = null;
      timer = null;
      onTick(null);
      onElapsed(identity, epoch);
      return;
    }
    onTick(Math.ceil(active.remaining / 1000));
    const scheduledEpoch = epoch;
    timer = schedule(() => { if (scheduledEpoch === epoch) tick(); }, Math.min(250, active.remaining));
  }
  function setVisible(next) {
    if (visible === next) return;
    visible = next;
    if (!active) return;
    if (!visible) {
      active.remaining = Math.max(0, active.deadline - now());
      if (timer !== null) unschedule(timer);
      timer = null;
    } else {
      active.deadline = now() + active.remaining;
      tick();
    }
  }
  return { cancel, setVisible, isCurrent: value => value === epoch,
    deferUntilVisible(identity, expectedEpoch) {
      if (expectedEpoch !== epoch) return;
      // Expiry may be queued behind another operation. If the panel became
      // hidden meanwhile, wait for foreground before dispatching it again.
      visible = false;
      active = { identity, remaining: 0, deadline: now() };
      onTick(0);
    },
    start(identity, foreground = true) {
      cancel();
      visible = foreground;
      active = { identity, remaining: 3000, deadline: now() + 3000 };
      if (visible) tick(); else onTick(3);
    },
  };
}
