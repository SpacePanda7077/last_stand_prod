// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { ICasinoGameV2, SessionContext, SessionPhase, StepResult } from '@chain-protocol/casino-sdk/contracts/ICasinoGameV2.sol';


contract MexicanStandoff is ICasinoGameV2 {

    uint256 private constant WAD = 1e18;
    // Player count and shooter count are NOT constants: the client sends both in
    // gameData (set once in examples/game/src/lib/odds.ts) and they are stored in
    // GameState. The odds are computed from them, so the 5% edge and the 12x cap
    // hold for every valid combination. Masks are uint32; the client builds them
    // with JS 32-bit ops, hence the 31-player ceiling.
    uint8 private constant MIN_PLAYERS = 2;
    uint8 private constant MAX_PLAYERS = 31;
    uint8 private constant MIN_SHOOTERS = 1; // max is playerCount - 1

    uint256 private constant EDGE_NUM = 95; // 5% house edge ...
    uint256 private constant EDGE_DEN = 100; // ... over 100
    uint256 private constant MAX_MULTIPLIER_WAD = 12 * WAD; // 12x hard cap

    /*
        Mines-style: the player picks p players they believe survive, and
        `shooters` (1..N-1) random players are eliminated. Win only if NONE of
        the picks were eliminated — all or nothing.

        P(win)     = C(N - p, shooters) / C(N, shooters)
        multiplier = 0.95 / P(win)            (constant 5% house edge)

        A (p, shooters) combo whose multiplier would exceed 12x is rejected,
        so every playable combo pays a true 95% RTP and the payout never
        exceeds 12x the wager.
    */

    struct GameState {
        uint32 pickMask; // bit i set = player i picked
        uint8 deathCount; // the shooter count chosen for this round
        uint8 playerCount; // N: players in the circle this round
    }

    // =============================================================
    //                          CAPS
    // =============================================================

    // Worst case regardless of shooter count: the 12x cap. Conservative and
    // identical to what the client uses for its max-wager calculation.
    function quoteCaps(
        uint256 wager,
        bytes calldata
    )
        external
        pure
        override
        returns (uint256 maxEscrowStake, uint256 maxReservedProfit)
    {
        maxEscrowStake = wager;
        maxReservedProfit = (wager * (MAX_MULTIPLIER_WAD - WAD)) / WAD;
    }

    // =============================================================
    //                       RISK PARAMETERS
    // =============================================================

    /// @dev Exact numbers when gameData holds (pickMask, shooters, playerCount); otherwise
    ///      the worst case over all playable combos (12x at P = 0.95 / 12).
    function quoteRiskParams(
        uint256 wager,
        bytes calldata gameData
    )
        external
        pure
        override
        returns (
            uint256 maxPayout,
            uint256 probabilityWad,
            uint256 expectedPayout,
            uint256 subJackpotVarianceScaled
        )
    {
        if (gameData.length == 96) {
            (uint32 pickMask, uint8 shooters, uint8 n) = abi.decode(gameData, (uint32, uint8, uint8));
            uint8 p = _popcount(pickMask);
            uint256 m = _multiplierWad(n, p, shooters);
            maxPayout = (wager * m) / WAD;
            probabilityWad = (WAD * _choose(n - p, shooters)) / _choose(n, shooters);
        } else {
            maxPayout = (wager * MAX_MULTIPLIER_WAD) / WAD;
            probabilityWad = (WAD * EDGE_NUM) / (EDGE_DEN * (MAX_MULTIPLIER_WAD / WAD));
        }
        expectedPayout = (maxPayout * probabilityWad) / WAD;
        subJackpotVarianceScaled = 0;
    }

    // =============================================================
    //                       SESSION START
    // =============================================================

    /*
        gameData: abi.encode(uint32 pickMask, uint8 deathCount, uint8 playerCount)
        deathCount is the shooter count (1..playerCount-1).
    */
    function onSessionStart(
        SessionContext calldata ctx
    )
        external
        pure
        override
        returns (StepResult memory result)
    {
        require(ctx.wagerBase > 0, "ZERO_WAGER");
        require(ctx.gameData.length == 96, "BAD_GAME_DATA");

        (uint32 pickMask, uint8 deathCount, uint8 n) = abi.decode(ctx.gameData, (uint32, uint8, uint8));

        require(n >= MIN_PLAYERS && n <= MAX_PLAYERS, "INVALID_PLAYER_COUNT");
        require(deathCount >= MIN_SHOOTERS && deathCount <= n - 1, "INVALID_SHOOTER_COUNT");
        require(pickMask != 0, "NO_PICKS");
        require(pickMask & ~_allPlayersMask(n) == 0, "INVALID_PLAYER_BIT"); // only bits 0..n-1 valid

        uint8 p = _popcount(pickMask);
        require(p <= n - deathCount, "TOO_MANY_PICKS");
        uint256 m = _multiplierWad(n, p, deathCount); // reverts with ODDS_EXCEED_MAX if the combo would pay > 12x
        uint256 maxPayout = (ctx.wagerBase * m) / WAD;

        GameState memory state = GameState({ pickMask: pickMask, deathCount: deathCount, playerCount: n });

        result.newGameState = abi.encode(state);
        result.escrowDelta = 0;
        // Reserve the profit a win can pay beyond the wager, so payout <= escrow + reserved profit.
        result.reservedProfitDelta = int256(maxPayout > ctx.wagerBase ? maxPayout - ctx.wagerBase : 0);
        result.nextPhase = SessionPhase.WAITING_RANDOMNESS;
        result.requestRandomnessNow = true;
        result.payout = 0;
    }

    // =============================================================
    //                       PLAYER ACTION
    // =============================================================

    function onPlayerAction(
        SessionContext calldata,
        bytes calldata
    )
        external
        pure
        override
        returns (StepResult memory)
    {
        revert("NO_PLAYER_ACTIONS");
    }

    // =============================================================
    //                        RANDOMNESS
    // =============================================================

    function onRandomness(
        SessionContext calldata ctx,
        bytes32 randomness
    )
        external
        pure
        override
        returns (StepResult memory result)
    {
        GameState memory state = _decodeState(ctx.gameState);

        uint32 aliveMask = _allPlayersMask(state.playerCount);
        bool anyPickEliminated = false;

        for (uint8 i = 0; i < state.deathCount; i++) {
            bytes32 subRandom = keccak256(abi.encodePacked(randomness, i));
            uint8 eliminated = _randomAlivePlayer(aliveMask, uint256(subRandom), state.playerCount);

            aliveMask &= ~(uint32(1) << eliminated);

            if ((state.pickMask & (uint32(1) << eliminated)) != 0) {
                anyPickEliminated = true;
            }
        }

        result.newGameState = ctx.gameState; // unchanged — terminal
        result.escrowDelta = 0;
        result.reservedProfitDelta = 0;
        result.nextPhase = SessionPhase.SETTLED;
        result.requestRandomnessNow = false;

        if (anyPickEliminated) {
            result.payout = 0;
            return result;
        }

        uint8 p = _popcount(state.pickMask);
        uint256 m = _multiplierWad(state.playerCount, p, state.deathCount);
        result.payout = (ctx.wagerBase * m) / WAD;
    }

    // =============================================================
    //                    ODDS (shooter-count aware)
    // =============================================================

    /// @dev multiplier = EDGE * C(n, d) / C(n - p, d), in WAD. Reverts if the
    ///      combo is invalid or would exceed the 12x cap.
    function _multiplierWad(uint8 n, uint8 p, uint8 d) internal pure returns (uint256) {
        require(n >= MIN_PLAYERS && n <= MAX_PLAYERS, "INVALID_PLAYER_COUNT");
        require(d >= MIN_SHOOTERS && d <= n - 1, "INVALID_SHOOTER_COUNT");
        require(p >= 1 && p <= n - d, "INVALID_PICK_COUNT");

        uint256 survive = _choose(n - p, d); // ways no pick is shot (>= 1)
        uint256 total = _choose(n, d);
        uint256 m = (EDGE_NUM * total * WAD) / (EDGE_DEN * survive);

        require(m <= MAX_MULTIPLIER_WAD, "ODDS_EXCEED_MAX");
        return m;
    }

    /// @notice Largest pick count playable with `shooters` among `n` players under the 12x cap.
    function maxPicks(uint8 n, uint8 shooters) external pure returns (uint8) {
        require(n >= MIN_PLAYERS && n <= MAX_PLAYERS, "INVALID_PLAYER_COUNT");
        require(shooters >= MIN_SHOOTERS && shooters <= n - 1, "INVALID_SHOOTER_COUNT");
        for (uint8 p = n - shooters; p >= 1; p--) {
            if (_fits(n, p, shooters)) return p;
        }
        return 0;
    }

    /// @notice Multiplier (WAD) for a combo — what the client displays.
    function multiplierWad(uint8 n, uint8 picks, uint8 shooters) external pure returns (uint256) {
        return _multiplierWad(n, picks, shooters);
    }

    function _fits(uint8 n, uint8 p, uint8 d) internal pure returns (bool) {
        uint256 m = (EDGE_NUM * _choose(n, d) * WAD) / (EDGE_DEN * _choose(n - p, d));
        return m <= MAX_MULTIPLIER_WAD;
    }

    /// @dev Exact binomial coefficient; each step is an integer C(n, i+1).
    function _choose(uint256 n, uint256 k) internal pure returns (uint256 result) {
        if (k > n) return 0;
        result = 1;
        for (uint256 i = 0; i < k; i++) {
            result = (result * (n - i)) / (i + 1);
        }
    }

    // =============================================================
    //                    FORFEIT / ABANDON
    // =============================================================

    function quoteForfeitPayout(
        SessionContext calldata
    )
        external
        pure
        override
        returns (uint256)
    {
        return 0; // one-shot bet — nothing resolved until randomness returns
    }

    // =============================================================
    //                         HELPERS
    // =============================================================

    function _decodeState(bytes memory encoded) internal pure returns (GameState memory) {
        require(encoded.length > 0, "EMPTY_STATE");
        return abi.decode(encoded, (GameState));
    }

    function _isAlive(uint32 mask, uint8 player) internal pure returns (bool) {
        return (mask & (uint32(1) << player)) != 0;
    }

    function _allPlayersMask(uint8 n) internal pure returns (uint32) {
        return uint32((uint256(1) << n) - 1);
    }

    function _popcount(uint32 mask) internal pure returns (uint8 count) {
        for (uint8 i = 0; i < 32; i++) {
            if (mask & (uint32(1) << i) != 0) count++;
        }
    }

    function _randomAlivePlayer(uint32 mask, uint256 random, uint8 n) internal pure returns (uint8) {
        uint8 aliveCount = 0;
        for (uint8 i = 0; i < n; i++) {
            if (_isAlive(mask, i)) aliveCount++;
        }
        require(aliveCount > 0, "NO_SURVIVORS");

        uint256 target = random % aliveCount;
        uint8 seen = 0;
        for (uint8 i = 0; i < n; i++) {
            if (_isAlive(mask, i)) {
                if (seen == target) return i;
                seen++;
            }
        }
        revert("RANDOM_SELECTION_FAILED");
    }
}