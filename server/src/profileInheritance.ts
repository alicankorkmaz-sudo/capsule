import type { Profile } from "./types";

/**
 * Profile inheritance.
 *
 * A profile may list parent profile ids in `extends`. Its effective capability
 * list is every parent's effective list (depth-first, in `extends` order)
 * followed by its own `capabilityIds`, de-duplicated so the first occurrence
 * wins. Inheritance is purely additive: a child cannot remove what a parent
 * enables.
 *
 * System profiles (Vanilla) take no part in inheritance. Vanilla means "launch
 * in safe mode with nothing enabled", so it can neither extend another profile
 * (it cannot be edited at all) nor be extended — a child of Vanilla would not
 * launch in safe mode, which would make the relationship meaningless.
 */

export interface EffectiveCapability {
  capabilityId: string;
  /** Id of the profile whose own `capabilityIds` contributed this entry. */
  sourceProfileId: string;
}

type ProfileMap = Record<string, Profile> | Map<string, Profile>;

function lookup(profiles: ProfileMap, id: string): Profile | undefined {
  if (profiles instanceof Map) return profiles.get(id);
  return Object.prototype.hasOwnProperty.call(profiles, id) ? profiles[id] : undefined;
}

export function profileParents(profile: Profile): string[] {
  if (profile.system) return [];
  return Array.isArray(profile.extends) ? profile.extends : [];
}

/**
 * Resolve a profile's effective capabilities with their origin.
 *
 * In strict mode (compile/apply/edit) a missing parent, an extended system
 * profile, or a cycle throws. In lenient mode (listing, UI, pending
 * propagation) broken edges are skipped so a hand-damaged store can still be
 * inspected and repaired.
 */
export function resolveEffectiveCapabilities(
  profiles: ProfileMap,
  profileId: string,
  options: { strict?: boolean } = {}
): EffectiveCapability[] {
  const strict = options.strict ?? true;
  const root = lookup(profiles, profileId);
  if (!root) {
    if (strict) throw new Error(`Profile not found: ${profileId}`);
    return [];
  }
  const result: EffectiveCapability[] = [];
  const seenCapabilities = new Set<string>();
  const finished = new Set<string>();
  const stack: Profile[] = [];

  const visit = (profile: Profile): void => {
    const cycleStart = stack.findIndex((entry) => entry.id === profile.id);
    if (cycleStart !== -1) {
      if (!strict) return;
      const chain = [...stack.slice(cycleStart), profile].map((entry) => entry.name).join(" -> ");
      throw new Error(`Profile inheritance cycle: ${chain}`);
    }
    // A diamond (two parents sharing an ancestor) is fine; the shared
    // ancestor contributes once, at its first position.
    if (finished.has(profile.id)) return;
    stack.push(profile);
    for (const parentId of profileParents(profile)) {
      const parent = lookup(profiles, parentId);
      if (!parent) {
        if (strict) throw new Error(`Profile "${profile.name}" extends a missing profile: ${parentId}`);
        continue;
      }
      if (parent.system) {
        if (strict) {
          throw new Error(`Profile "${profile.name}" extends the ${parent.name} system profile, which cannot be extended.`);
        }
        continue;
      }
      visit(parent);
    }
    stack.pop();
    finished.add(profile.id);
    for (const capabilityId of profile.capabilityIds) {
      if (seenCapabilities.has(capabilityId)) continue;
      seenCapabilities.add(capabilityId);
      result.push({ capabilityId, sourceProfileId: profile.id });
    }
  };

  visit(root);
  return result;
}

export function effectiveCapabilityIds(
  profiles: ProfileMap,
  profileId: string,
  options: { strict?: boolean } = {}
): string[] {
  return resolveEffectiveCapabilities(profiles, profileId, options).map((entry) => entry.capabilityId);
}

/** Profiles that list `profileId` directly in their `extends`. */
export function directChildren(profiles: ProfileMap, profileId: string): Profile[] {
  const all = profiles instanceof Map ? [...profiles.values()] : Object.values(profiles);
  return all.filter((profile) => profileParents(profile).includes(profileId));
}

/** `profileId` plus every profile that inherits from it, directly or not. */
export function selfAndDescendants(profiles: ProfileMap, profileId: string): Set<string> {
  const result = new Set<string>([profileId]);
  const queue = [profileId];
  while (queue.length) {
    const current = queue.shift()!;
    for (const child of directChildren(profiles, current)) {
      if (result.has(child.id)) continue;
      result.add(child.id);
      queue.push(child.id);
    }
  }
  return result;
}

/**
 * Edit-time validation for a profile's proposed `extends` list. Checks that
 * every parent exists, that the profile does not extend itself or a system
 * profile, and that the resulting graph has no cycle through this profile.
 */
export function assertValidExtends(
  profiles: Record<string, Profile>,
  candidate: Profile
): void {
  const parents = profileParents(candidate);
  if (candidate.system && candidate.extends?.length) {
    throw new Error(`The ${candidate.name} system profile cannot extend other profiles.`);
  }
  for (const parentId of parents) {
    if (parentId === candidate.id) throw new Error(`Profile "${candidate.name}" cannot extend itself.`);
    const parent = profiles[parentId];
    if (!parent) throw new Error(`Unknown parent profile: ${parentId}`);
    if (parent.system) throw new Error(`The ${parent.name} system profile cannot be extended.`);
  }
  // Cycles created by this edit necessarily pass through the candidate, so a
  // strict resolution of the candidate in the hypothetical graph finds them.
  resolveEffectiveCapabilities({ ...profiles, [candidate.id]: candidate }, candidate.id, { strict: true });
}
