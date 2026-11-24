// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { ICasinoGameV2, SessionContext, SessionPhase, StepResult } from '@chain-protocol/casino-sdk/contracts/ICasinoGameV2.sol';

/// @notice Flips up to ten coins at 98% RTP. The player picks a side and how many coins must land
///         on it; the payout is the fair odds of that outcome scaled by the RTP.
contract CoinflipGame is ICasinoGameV2 {
  uint256 private constant WAD = 1e18;
  uint16 private constant BASIS_POINTS = 10_000;
  uint16 private constant RTP_BPS = 9_800;
  uint8 private constant MAX_COIN_COUNT = 10;

  struct CoinflipState {
    bool pickHeads;
    uint8 coinCount;
    uint8 minWins;
    bytes32 providerRandomness;
  }

  error CoinflipGame__InvalidGameData();
  error CoinflipGame__InvalidState();
  error CoinflipGame__NoPlayerAction();
  error CoinflipGame__InvalidCoinCount(uint8 coinCount);
  error CoinflipGame__InvalidMinWins(uint8 minWins, uint8 coinCount);

  function quoteCaps(
    uint256 wager,
    bytes calldata gameData
  ) external pure returns (uint256 maxEscrowStake, uint256 maxReservedProfit) {
    (, uint8 coinCount, uint8 minWins) = _decodeAndValidateGameData(gameData);
    uint256 maxPayout = _getMaxPayout(wager, coinCount, minWins);
    maxEscrowStake = wager;
    maxReservedProfit = maxPayout > wager ? maxPayout - wager : 0;
  }

  function quoteRiskParams(
    uint256 wager,
    bytes calldata gameData
  )
    external
    pure
    returns (
      uint256 maxPayout,
      uint256 probabilityWad,
      uint256 expectedPayout,
      uint256 subJackpotVarianceScaled
    )
  {
    (, uint8 coinCount, uint8 minWins) = _decodeAndValidateGameData(gameData);
    maxPayout = _getMaxPayout(wager, coinCount, minWins);
    probabilityWad = (uint256(_winningWays(coinCount, minWins)) * WAD) >> coinCount;
    expectedPayout = (wager * RTP_BPS) / BASIS_POINTS;
    subJackpotVarianceScaled = 0;
  }

  function onSessionStart(
    SessionContext calldata ctx
  ) external pure returns (StepResult memory stepResult) {
    if (ctx.gameState.length != 0) revert CoinflipGame__InvalidState();

    (bool pickHeads, uint8 coinCount, uint8 minWins) = _decodeAndValidateGameData(ctx.gameData);
    uint256 maxPayout = _getMaxPayout(ctx.wagerBase, coinCount, minWins);

    stepResult.newGameState = abi.encode(
      CoinflipState({
        pickHeads: pickHeads,
        coinCount: coinCount,
        minWins: minWins,
        providerRandomness: bytes32(0)
      })
    );
    stepResult.reservedProfitDelta = int256(
      maxPayout > ctx.wagerBase ? maxPayout - ctx.wagerBase : 0
    );
    stepResult.nextPhase = SessionPhase.WAITING_RANDOMNESS;
    stepResult.requestRandomnessNow = true;
  }

  function onPlayerAction(
    SessionContext calldata,
    bytes calldata
  ) external pure returns (StepResult memory) {
    revert CoinflipGame__NoPlayerAction();
  }

  function onRandomness(
    SessionContext calldata ctx,
    bytes32 randomness
  ) external pure returns (StepResult memory stepResult) {
    CoinflipState memory state = abi.decode(ctx.gameState, (CoinflipState));
    if (state.providerRandomness != bytes32(0) || randomness == bytes32(0)) {
      revert CoinflipGame__InvalidState();
    }

    state.providerRandomness = randomness;
    uint8 headsCount = _countHeads(randomness, state.coinCount);
    uint8 pickedSideWins = state.pickHeads ? headsCount : state.coinCount - headsCount;
    bool won = pickedSideWins >= state.minWins;

    stepResult.newGameState = abi.encode(state);
    stepResult.nextPhase = SessionPhase.SETTLED;
    stepResult.payout = won ? _getMaxPayout(ctx.wagerBase, state.coinCount, state.minWins) : 0;
  }

  function quoteForfeitPayout(SessionContext calldata) external pure returns (uint256) {
    return 0;
  }

  function _decodeAndValidateGameData(
    bytes calldata gameData
  ) private pure returns (bool pickHeads, uint8 coinCount, uint8 minWins) {
    if (gameData.length != 96) revert CoinflipGame__InvalidGameData();

    (pickHeads, coinCount, minWins) = abi.decode(gameData, (bool, uint8, uint8));

    if (coinCount == 0 || coinCount > MAX_COIN_COUNT) {
      revert CoinflipGame__InvalidCoinCount(coinCount);
    }
    if (minWins == 0 || minWins > coinCount) {
      revert CoinflipGame__InvalidMinWins(minWins, coinCount);
    }
  }

  /// @dev Coin `i` lands heads when bit `i` of the VRF word is set.
  function _countHeads(bytes32 randomness, uint8 coinCount) private pure returns (uint8 headsCount) {
    uint256 bits = uint256(randomness);
    for (uint8 i = 0; i < coinCount; ++i) {
      if ((bits >> i) & 1 == 1) headsCount += 1;
    }
  }

  function _winningWays(uint8 coinCount, uint8 minWins) private pure returns (uint16 winWays) {
    for (uint8 wins = minWins; wins <= coinCount; ++wins) {
      winWays += _nCk(coinCount, wins);
    }
  }

  function _nCk(uint8 n, uint8 k) private pure returns (uint16) {
    if (k > n) return 0;
    if (k == 0 || k == n) return 1;
    uint8 effectiveK = k < n - k ? k : n - k;
    uint256 result = 1;
    for (uint8 i = 1; i <= effectiveK; ++i) {
      result = (result * (n - effectiveK + i)) / i;
    }
    return uint16(result);
  }

  function _getMaxPayout(
    uint256 wager,
    uint8 coinCount,
    uint8 minWins
  ) private pure returns (uint256) {
    uint256 totalWays = uint256(1) << coinCount;
    return (wager * RTP_BPS * totalWays) / (uint256(BASIS_POINTS) * _winningWays(coinCount, minWins));
  }
}
