import { useCallback, useEffect, useRef, useState } from "react";
import { useCasinoHost } from "../lib/useCasinoHost";
import type { HexString } from "@chain-protocol/casino-sdk";
import {
    decodeAbiParameters,
    encodeAbiParameters,
    encodePacked,
    keccak256,
} from "viem";
import { EventBus } from "../game/EventBus";
import { useBalance } from "../store/Balance";
import {
    DEFAULT_SHOOTERS,
    MAX_MULTIPLIER,
    MAX_SHOOTERS,
    MIN_SHOOTERS,
    PLAYER_COUNT,
    maxPicksFor,
    multiplierDisplay,
    winChance,
} from "../lib/Odds";

export type MexicanStandoffState = {
    pickMask: number;
    deathCount: number;
    playerCount: number;
};

const GAME_STATE_PARAMS = [
    { type: "uint32" },
    { type: "uint8" },
    { type: "uint8" },
] as const;

export function decodeGameState(
    gameState: HexString,
): MexicanStandoffState | null {
    try {
        const [pickMask, deathCount, playerCount] = decodeAbiParameters(
            GAME_STATE_PARAMS,
            gameState,
        );
        return { pickMask, deathCount, playerCount };
    } catch {
        return null;
    }
}

const GAME_DATA_PARAMS = [
    { type: "uint32" },
    { type: "uint8" },
    { type: "uint8" },
] as const;

export function encodePicksAndDeathCount(
    pickedIndices: number[],
    deathCount: number = DEFAULT_SHOOTERS,
): HexString {
    const invalid = pickedIndices.filter(
        (i) => !Number.isInteger(i) || i < 0 || i >= PLAYER_COUNT,
    );
    if (invalid.length > 0) {
        throw new Error(
            `Invalid player index ${invalid.join(", ")} (valid: 0-${PLAYER_COUNT - 1}), picks=${JSON.stringify(pickedIndices)}, PLAYER_COUNT=${PLAYER_COUNT}`,
        );
    }
    const mask = pickedIndices.reduce((acc, i) => acc | (1 << i), 0);
    // The player count comes from odds.ts and is sent to the contract with the bet.
    return encodeAbiParameters(GAME_DATA_PARAMS, [
        mask,
        deathCount,
        PLAYER_COUNT,
    ]);
}

function popcount(mask: number): number {
    let count = 0;
    for (let i = 0; i < PLAYER_COUNT; i++) if (mask & (1 << i)) count++;
    return count;
}

export const EMPTY_HEX = "0x" as HexString;

function computeEliminatedPlayers(
    randomness: HexString,
    deathCount: number,
    playerCount: number,
): number[] {
    let aliveMask = (1 << playerCount) - 1;
    const eliminated: number[] = [];

    for (let i = 0; i < deathCount; i++) {
        const subRandom = keccak256(
            encodePacked(
                ["bytes32", "uint8"],
                [randomness as `0x${string}`, i],
            ),
        );
        const randomBig = BigInt(subRandom);

        let aliveCount = 0;
        for (let p = 0; p < playerCount; p++) {
            if (aliveMask & (1 << p)) aliveCount++;
        }

        const target = randomBig % BigInt(aliveCount);
        let seen = 0n;
        for (let p = 0; p < playerCount; p++) {
            if (aliveMask & (1 << p)) {
                if (seen === target) {
                    eliminated.push(p);
                    aliveMask &= ~(1 << p);
                    break;
                }
                seen++;
            }
        }
    }
    return eliminated;
}

type SessionRow = {
    sessionKey: string;
    sessionId: string;
    phase: number;
    phaseName: string;
    isSettled: boolean;
    payout?: string;
    wager: string;
    stake: string;
    raw: { gameState: HexString; randomness?: HexString; [k: string]: any };
};

export default function BetWidgetSidebar() {
    const { hostApi, snapshot } = useCasinoHost();
    const hostApiRef = useRef(hostApi);
    hostApiRef.current = hostApi;
    const balance = useBalance((s) => s.balance);
    const setBalance = useBalance((s) => s.setBalance);
    const [currentSessionKey, setCurrentSessionKey] = useState<string | null>(
        null,
    );
    const [row, setRow] = useState<SessionRow | null>(null);
    const [state, setState] = useState<MexicanStandoffState | null>(null);
    const [picks, setPicks] = useState<number[]>([]);
    const [eliminated, setEliminated] = useState<number[]>([]);
    const [suvivor_empty, setSuvivorEmpty] = useState(false);
    const [amount_empty, setAmountEmpty] = useState(false);
    const [wager, setWager] = useState<BigInt>(1n);
    // One shared shooter count: sent to the contract in gameData and used for
    // the odds, the animation and the result decoding.
    const [shooters, setShooters] = useState(DEFAULT_SHOOTERS);

    const lastEmittedGameState = useRef<string | null>(null);
    const openInFlight = useRef(false);
    const decisionEmittedFor = useRef<string | null>(null);

    const maxPicks = maxPicksFor(shooters);

    // Force-deselect excess picks when more shooters lower the allowed pick count
    useEffect(() => {
        setPicks((current) => {
            if (current.length <= maxPicks) return current;

            // Keep the lowest player numbers (most stable)
            const sorted = [...current].sort((a, b) => a - b);
            return sorted.slice(0, maxPicks);
        });
    }, [maxPicks]);

    const togglePick = useCallback(
        (i: number) => {
            setPicks((current) => {
                // Deselect
                if (current.includes(i)) {
                    return current.filter((p) => p !== i);
                }

                // Only hard limit
                if (current.length >= maxPicks) return current;

                return [...current, i];
            });
        },
        [maxPicks],
    );
    useEffect(() => {
        console.log(picks);
        EventBus.emit("survivor_choosen", picks);
    }, [picks]);

    //=============================================================//
    //  =============Test Open Round =============================//
    //============================================================//

    function getRandomPicks(deathCount: number) {
        const numbers: number[] = [];

        while (numbers.length < deathCount) {
            const randomNum = Math.floor(Math.random() * PLAYER_COUNT);
            if (!numbers.includes(randomNum)) {
                numbers.push(randomNum);
            }
        }

        return numbers;
    }

    const openTestRound = useCallback(async () => {
        if (picks.length < 1) {
            setSuvivorEmpty(true);
            setTimeout(() => {
                setSuvivorEmpty(false);
            }, 3000);
            EventBus.emit("show_notification", "Choose A Survivor");
            return;
        }
        if (Number(wager) < 1) {
            setAmountEmpty(true);
            setTimeout(() => {
                setAmountEmpty(false);
            }, 3000);
            EventBus.emit("show_notification", "Invalid Amount");
            return;
        }

        const rand_picks = getRandomPicks(shooters);
        setEliminated(rand_picks);
        setCurrentSessionKey("uutygyyfy");
        const newBalance = balance - Number(wager);
        setBalance(newBalance);
        console.log(rand_picks);
    }, [picks, wager, shooters]);

    const openRound = useCallback(async () => {
        if (!hostApi || openInFlight.current) {
            openTestRound();
            return;
        }
        if (picks.length < 1) {
            setSuvivorEmpty(true);
            setTimeout(() => {
                setSuvivorEmpty(false);
            }, 3000);
            EventBus.emit("show_notification", "Choose A Survivor");
            return;
        }
        if (Number(wager) < 1) {
            setAmountEmpty(true);
            setTimeout(() => {
                setAmountEmpty(false);
            }, 3000);
            EventBus.emit("show_notification", "Invalid Amount");
            return;
        }
        openInFlight.current = true;
        try {
            console.log(
                "openSession picks:",
                picks,
                "shooters:",
                shooters,
                "PLAYER_COUNT:",
                PLAYER_COUNT,
            );
            const { sessionKey } = await hostApi.openSession({
                wager: wager.toString(),
                gameData: encodePicksAndDeathCount(picks, shooters),
                randomnessRequestData: EMPTY_HEX,
            });
            setCurrentSessionKey(sessionKey);
            setRow(null);
            setState(null);
            lastEmittedGameState.current = null;
        } catch (cause) {
            console.log(cause);
        } finally {
            openInFlight.current = false;
        }
    }, [hostApi, picks, wager, shooters]);

    const resetForNewBet = useCallback(() => {
        setCurrentSessionKey(null);
        setRow(null);
        setState(null);
        setPicks([]);
        lastEmittedGameState.current = null;
    }, []);

    useEffect(() => {
        if (!snapshot || !currentSessionKey) return;
        const found = snapshot.sessions.items.find(
            (item: any) => item.sessionKey === currentSessionKey,
        ) as SessionRow | undefined;
        if (!found) return;

        setRow(found);

        if (
            !found.raw?.gameState ||
            found.raw.gameState === lastEmittedGameState.current
        )
            return;
        lastEmittedGameState.current = found.raw.gameState;

        const decoded = decodeGameState(found.raw.gameState);
        setState(decoded);
    }, [snapshot, currentSessionKey]);

    useEffect(() => {
        if (!row?.isSettled || !state || !currentSessionKey) return;
        if (decisionEmittedFor.current === currentSessionKey) return;
        decisionEmittedFor.current = currentSessionKey;

        const eliminatedPlayers = row.raw?.randomness
            ? computeEliminatedPlayers(
                  row.raw.randomness,
                  state.deathCount,
                  state.playerCount,
              )
            : [];
        const pickedCount = popcount(state.pickMask);
        const won = row.payout !== undefined && row.payout !== "0";

        EventBus.emit("decision", {
            pickMask: state.pickMask,
            picks,
            currentMultiplier: multiplierDisplay(pickedCount, state.deathCount),
            eliminatedPlayers,
            won,
            payout: row.payout,
        });
    }, [row, state, currentSessionKey]);
    const hasNoOverlap = (arr1: number[], arr2: number[]) => {
        // Returns false if any number in arr1 is found in arr2, otherwise returns true
        return !arr1.some((num) => arr2.includes(num));
    };

    //===========================================================================================//
    //===================================Test Confirm ===========================================//
    //===========================================================================================//

    useEffect(() => {
        if (eliminated.length > 0) {
            const won = hasNoOverlap(picks, eliminated);
            EventBus.emit("decision", {
                picks,
                currentMultiplier,
                eliminatedPlayers: eliminated,
                won,
            });
        }
    }, [eliminated]);

    // =============Handle settled ===============//
    const reslove_balance = useCallback(
        (multiplier: number) => {
            const bal = useBalance.getState().balance;
            const balance_to_add = Number(wager) * multiplier;
            const new_balance = bal + balance_to_add;
            console.log(wager, new_balance);
            setBalance(new_balance);
        },
        [wager],
    );
    useEffect(() => {
        EventBus.on("settled", (multiplier: number) => {
            reslove_balance(multiplier);
            setRow({
                sessionKey: "",
                sessionId: "",
                phase: 0,
                phaseName: "",
                isSettled: true,
                payout: "1",
                wager: wager.toString(),
                stake: "",
                raw: { gameState: `0x`, randomness: "0x" },
            });
        });
        return () => {
            EventBus.off("settled");
        };
    }, [wager]);

    const suggeested_amount = [1n, 5n, 10n, 20n, 50n];

    // if (!hostApi) {
    //     return (
    //         <div className="ck-canvas-loading">
    //             <div className="ck-canvas-loading__card">
    //                 <div className="ck-canvas-loading__spinner" aria-hidden />
    //                 <span className="ck-canvas-loading__label">
    //                     Connecting to host…
    //                 </span>
    //             </div>
    //         </div>
    //     );
    // }

    const roundNotStarted = currentSessionKey === null;
    const settled = row?.isSettled === true;
    const won = settled && row?.payout !== undefined && row.payout !== "0";
    const awaitingRandomness =
        row?.phaseName === "WAITING_RANDOMNESS" && !settled;
    const currentMultiplier = multiplierDisplay(picks.length, shooters);
    const currentWinChance = winChance(picks.length, shooters);

    return (
        <>
            <div className=" border-2 border-[#FDC94B] fixed top-1/2 left-1/2 mt-5 lg:-translate-y-1/2 -translate-x-1/2 lg:-translate-x-full lg:left-[97%] w-[95%] lg:w-[30%] h-[45%] max-h-[45%] lg:h-[70%] lg:max-h-[70%] overflow-y-auto bg-[#0D3354] p-4 rounded-lg flex flex-col gap-4 z-1000 shadow-black shadow-lg">
                {roundNotStarted || settled ? (
                    <>
                        {settled && (
                            <p
                                className={
                                    won
                                        ? "text-green-400 text-sm"
                                        : "text-red-400 text-sm"
                                }
                            ></p>
                        )}

                        {!settled && (
                            <>
                                <p className="text-xs opacity-100 font-bold">
                                    Pick up to {maxPicks} players (
                                    {picks.length}/{maxPicks})
                                </p>
                                <div className="bg-[#0B2740] p-2 rounded-lg border border-[#FDC94B]  shadow-lg shadow-black ">
                                    {" "}
                                    <div
                                        className={`grid grid-cols-5 gap-2 bg-[#336DBE] px-2 py-1 rounded-lg transition-shadow duration-300 ${
                                            suvivor_empty
                                                ? "shadow-[0_0_20px_5px_rgba(250,52,52,1)] animate-[pulse_1.5s_cubic-bezier(0.4,0,0.6,1)_infinite]"
                                                : ""
                                        }`}
                                    >
                                        {Array.from(
                                            { length: PLAYER_COUNT },
                                            (_, i) => i,
                                        ).map((i) => (
                                            <button
                                                key={i}
                                                onClick={() => togglePick(i)}
                                                className={`w-full rounded-md p-1 ${
                                                    picks.includes(i)
                                                        ? "bg-gradient-to-b from-[#FDC94B] to-[#F9B92D] font-bold"
                                                        : "bg-gradient-to-b from-[#113A74] to-[#0A2C58] font-bold"
                                                }`}
                                            >
                                                {i + 1}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                <div className="bg-[#0B2740] p-2 rounded-lg border border-[#FDC94B] shadow-lg shadow-black">
                                    <div className="w-full flex items-end justify-between gap-2 p-2">
                                        {suggeested_amount.map((amount) => (
                                            <button
                                                onClick={() => setWager(amount)}
                                                className={`w-full py-2  rounded-md ${amount === wager ? "bg-gradient-to-b from-[#4BD97A] to-[#2DA84E] " : "bg-gradient-to-b from-[#FDC94B] to-[#F9B92D] border-b-4 border-b-[#B88A27]"} `}
                                            >
                                                $ {amount}
                                            </button>
                                        ))}
                                    </div>

                                    <input
                                        type="number"
                                        value={Number(wager)}
                                        onChange={(e) => {
                                            setWager(BigInt(e.target.value));
                                        }}
                                        className={`w-full border  rounded-lg p-2 bg-[#030b11] text-[#FDC94B] 
                                       ${
                                           amount_empty
                                               ? "shadow-[0_0_20px_5px_rgba(250,52,52,1)] animate-[pulse_1.5s_cubic-bezier(0.4,0,0.6,1)_infinite] border-[0xff0000]"
                                               : " border-[#FDC94B]"
                                       }`}
                                    />
                                </div>

                                <div className="bg-[#0B2740] p-2 rounded-lg border border-[#FDC94B] shadow-lg shadow-black flex items-center justify-between gap-2">
                                    <span className="text-xs font-bold">
                                        Shooters
                                    </span>
                                    <div className="flex items-center gap-2">
                                        <button
                                            aria-label="Fewer shooters"
                                            disabled={shooters <= MIN_SHOOTERS}
                                            onClick={() =>
                                                setShooters((s) =>
                                                    Math.max(
                                                        MIN_SHOOTERS,
                                                        s - 1,
                                                    ),
                                                )
                                            }
                                            className="w-8 h-8 rounded-md font-bold bg-gradient-to-b from-[#113A74] to-[#0A2C58] disabled:opacity-40"
                                        >
                                            −
                                        </button>
                                        <span className="w-6 text-center font-bold text-[#FDC94B]">
                                            {shooters}
                                        </span>
                                        <button
                                            aria-label="More shooters"
                                            disabled={shooters >= MAX_SHOOTERS}
                                            onClick={() =>
                                                setShooters((s) =>
                                                    Math.min(
                                                        MAX_SHOOTERS,
                                                        s + 1,
                                                    ),
                                                )
                                            }
                                            className="w-8 h-8 rounded-md font-bold bg-gradient-to-b from-[#FDC94B] to-[#F9B92D] disabled:opacity-40"
                                        >
                                            +
                                        </button>
                                    </div>
                                </div>

                                <p className="text-xs opacity-60">
                                    {shooters} of {PLAYER_COUNT} players get
                                    shot. Max payout {MAX_MULTIPLIER}x.
                                </p>

                                <p className="text-sm">
                                    {picks.length > 0
                                        ? `Multiplier: ${currentMultiplier.toFixed(2)}x · Win chance: ${(currentWinChance * 100).toFixed(1)}%`
                                        : "Pick at least 1 player"}
                                </p>
                            </>
                        )}

                        {settled ? (
                            <button
                                onClick={() => {
                                    resetForNewBet();
                                    EventBus.emit("play_again");
                                }}
                                className="w-full py-2 border border-white rounded-md bg-gradient-to-b from-[#4BD97A] to-[#2DA84E] shadow-[0_4px_0_#2DA84E,0_0_20px_rgba(0,255,120,0.4)]"
                            >
                                PLAY AGAIN
                            </button>
                        ) : (
                            <button
                                onClick={() => openRound()}
                                className="w-full py-2 border border-white rounded-md bg-gradient-to-b from-[#FDC94B] to-[#F9B92D] shadow-[0_4px_0_#F9B92D,0_0_20px_rgba(0,120,255,0.6)]"
                            >
                                BET
                            </button>
                        )}
                    </>
                ) : (
                    <p className="text-sm opacity-70">
                        {awaitingRandomness
                            ? "Waiting for result…"
                            : "Loading…"}
                    </p>
                )}
            </div>
        </>
    );
}
