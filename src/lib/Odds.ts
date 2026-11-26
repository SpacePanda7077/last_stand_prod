/**
 * Shared shooter-count + odds model.
 *
 * This file is the client mirror of `simulator/contracts/mycontract.sol`.
 * Every constant and every line of integer math below must stay identical to
 * the contract, so the multiplier shown in the UI is exactly what the
 * contract pays out.
 *
 * Rules
 *  - PLAYER_COUNT players stand in a circle.
 *  - `shooters` of them are shot (1..PLAYER_COUNT-1). One shared value: the
 *    client encodes it into gameData, the contract stores it in GameState.
 *  - The player picks `picks` survivors and wins only if none of them is shot.
 *
 * Odds
 *  - P(win) = C(N - picks, shooters) / C(N, shooters)
 *  - multiplier = EDGE * (1 / P(win)), a constant 5% house edge.
 *  - Hard cap: MAX_MULTIPLIER (12x). A (picks, shooters) combo whose fair
 *    multiplier would exceed the cap is not offered, so the edge stays a
 *    true 5% for every combo that can be played (no silent under-payment).
 */

// Sent to the contract with every bet (gameData), so this is the only place to set it.
// Max 31: pick masks are built with JS 32-bit bit operations.
export const PLAYER_COUNT = 20;
export const MIN_SHOOTERS = 1;
export const DEFAULT_SHOOTERS = 2;

export const WAD = 1_000_000_000_000_000_000n;
export const EDGE_NUM = 95n; // 5% house edge, over EDGE_DEN
export const EDGE_DEN = 100n;
export const MAX_MULTIPLIER = 12;
export const MAX_MULTIPLIER_WAD = 12n * WAD;

/** Binomial coefficient, exact. Each step stays an integer (C(n, i+1)). */
export function choose(n: number, k: number): bigint {
    if (k < 0 || k > n) return 0n;
    let result = 1n;
    for (let i = 0; i < k; i++) {
        result = (result * BigInt(n - i)) / BigInt(i + 1);
    }
    return result;
}

export function clampShooters(shooters: number): number {
    return Math.min(MAX_SHOOTERS, Math.max(MIN_SHOOTERS, Math.trunc(shooters)));
}

/**
 * Multiplier in WAD for (picks, shooters), or 0n when the combo is not
 * playable (bad input, or the fair multiplier would exceed the 12x cap).
 * Matches `_multiplierWad` in the contract (which reverts instead of 0n).
 */
export function multiplierWad(
    picks: number,
    shooters: number,
    playerCount: number = PLAYER_COUNT,
): bigint {
    if (shooters < MIN_SHOOTERS || shooters > playerCount - 1) return 0n;
    if (picks < 1 || picks > playerCount - shooters) return 0n;

    const survive = choose(playerCount - picks, shooters); // ways no pick is shot
    const total = choose(playerCount, shooters);
    const m = (EDGE_NUM * total * WAD) / (EDGE_DEN * survive);

    return m > MAX_MULTIPLIER_WAD ? 0n : m;
}

/** Largest number of picks that still keeps the multiplier within the cap. */
export function maxPicksFor(
    shooters: number,
    playerCount: number = PLAYER_COUNT,
): number {
    for (let p = playerCount - shooters; p >= 1; p--) {
        if (multiplierWad(p, shooters, playerCount) > 0n) return p;
    }
    return 0;
}

export function multiplierDisplay(picks: number, shooters: number): number {
    return Number(multiplierWad(picks, shooters)) / 1e18;
}

/** Win probability in [0, 1] — display only. */
export function winChance(picks: number, shooters: number): number {
    if (picks < 1 || picks > PLAYER_COUNT - shooters) return 0;
    return (
        Number(choose(PLAYER_COUNT - picks, shooters)) /
        Number(choose(PLAYER_COUNT, shooters))
    );
}

/**
 * Highest shooter count that still leaves at least one playable pick under
 * the 12x cap (with 20 players, 19 shooters would pay 19x for a single pick,
 * so it is not offered). Computed once from the same odds math above.
 */
export const MAX_SHOOTERS: number = (() => {
    for (let d = PLAYER_COUNT - 1; d >= MIN_SHOOTERS; d--) {
        if (maxPicksFor(d) >= 1) return d;
    }
    return MIN_SHOOTERS;
})();
