import { TrustedObjectiveExperience } from "./trusted-objective-experience";

export default async function InitiativePage(input: { params: Promise<{ initiativeId: string }> }) {
  const { initiativeId } = await input.params;
  return <TrustedObjectiveExperience initiativeId={initiativeId} />;
}
