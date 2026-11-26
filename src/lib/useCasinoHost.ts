import { useEffect, useState } from "react";
import {
    connectGameToHost,
    observeGameContentSize,
    type GuestApi,
    type HostApi,
    type HostSnapshot,
} from "@chain-protocol/casino-sdk/guest";

/**
 * Guest side of the casino bridge: connects to the parent host on mount,
 * exposes the host's signing API once the handshake resolves, and mirrors
 * every `setState` push into React state.
 */
export function useCasinoHost(): {
    hostApi: HostApi | null;
    snapshot: HostSnapshot | null;
} {
    const [hostApi, setHostApi] = useState<HostApi | null>(null);
    const [snapshot, setSnapshot] = useState<HostSnapshot | null>(null);

    useEffect(() => {
        let mounted = true;

        const guestMethods: GuestApi = {
            async setState(nextSnapshot) {
                console.log("setState called", nextSnapshot);
                if (!mounted) return;
                setSnapshot(nextSnapshot);
            },
        };

        const connection = connectGameToHost(guestMethods);

        void connection.promise
            .then((parent) => {
                if (mounted) setHostApi(parent);
                console.log(parent);
            })
            .catch(() => {
                // Handshake failed — the "waiting for host" screen stays up. Opening
                // the game outside the host iframe never resolves, which is expected.
            });

        return () => {
            mounted = false;
            connection.destroy();
        };
    }, []);

    useEffect(() => {
        console.log("snapshot", snapshot);
    }, [snapshot]);

    useEffect(() => {
        if (!hostApi) return;
        const observer = observeGameContentSize(hostApi);
        return () => observer.disconnect();
    }, [hostApi]);

    return { hostApi, snapshot };
}
