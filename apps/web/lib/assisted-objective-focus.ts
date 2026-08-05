export type AssistedObjectiveFocusTarget = "evidence" | "objective";

interface FocusableControl {
  focus(): void;
}

interface SingleFlightOwner {
  current: symbol | null;
}

export function focusAssistedObjectiveTarget(
  target: AssistedObjectiveFocusTarget,
  controls: Readonly<Record<AssistedObjectiveFocusTarget, FocusableControl | null>>
): boolean {
  const control = controls[target];
  if (!control) return false;
  control.focus();
  return true;
}

export async function runSingleFlight<Result>(
  owner: SingleFlightOwner,
  setBusy: (busy: boolean) => void,
  request: () => Promise<Result>
): Promise<Result | undefined> {
  if (owner.current !== null) return undefined;

  const token = Symbol("single-flight owner");
  owner.current = token;
  setBusy(true);
  try {
    return await request();
  } finally {
    if (owner.current === token) {
      owner.current = null;
      setBusy(false);
    }
  }
}
