import { useCallback, useEffect, useRef } from "react";
import useSWR from "swr";
import { useApi } from "@/shared/lib/hooks/useApi";
import { useWebsocket } from "@/utils/hooks/usePusher";
import { Preset, useSilencedPresets } from "@/entities/presets/model";
import { AlertsQuery } from "@/entities/alerts/model";

const NOTIFICATION_TITLE = "Keep - Alert";
const NOTIFICATION_BODY = "An alert requires your attention!";
const NOTIFICATION_TAG = "keep-noisy-alert";

/**
 * Plays an inaudible 20 kHz tone at -62 dB via the Web Audio API.
 *
 * Chrome exempt tabs with active audio contexts from its "Intensive Wake Up
 * Throttling" (introduced in Chrome 88), which otherwise reduces setInterval
 * to fire at most once per minute for background tabs. By keeping an active
 * AudioContext, the SWR refreshInterval stays close to its configured 5 s,
 * and ReactPlayer's AudioContext won't be suspended when an alert fires.
 *
 * The 20 kHz frequency is above the human hearing range; the 0.0008 gain
 * (~-62 dB) adds a small safety margin so it is inaudible even on hardware
 * that doesn't perfectly roll off at 20 kHz.
 *
 * A visible speaker icon will appear in the browser tab — intentional for
 * an alerting tool because it signals to operators that the tab is active.
 *
 * Must be called from a user-gesture handler (Chrome autoplay policy).
 */
function startSilentAudioKeepAlive(): (() => void) | undefined {
  try {
    const AudioCtxCtor =
      window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtxCtor) return;

    const ctx = new AudioCtxCtor() as AudioContext;
    const osc = ctx.createOscillator();
    osc.frequency.value = 20000; // above human hearing range

    const gain = ctx.createGain();
    gain.gain.value = 0.0008; // ~-62 dB — inaudible

    osc.connect(gain).connect(ctx.destination);
    osc.start();

    return () => {
      osc.stop();
      ctx.close();
    };
  } catch {
    // AudioContext may be unavailable (SSR, sandboxed iframe, etc.)
  }
}

function requestNotificationPermission() {
  if (typeof Notification === "undefined" || Notification.permission !== "default") {
    return;
  }
  Notification.requestPermission();
}

function showAlertNotification() {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") {
    return;
  }
  // Replace any previous notification with the same tag to avoid stacking
  new Notification(NOTIFICATION_TITLE, {
    body: NOTIFICATION_BODY,
    tag: NOTIFICATION_TAG,
    // renotify is not yet in the TS lib types but is supported in Chrome
    ...(({ renotify: true }) as any),
    icon: "/keep.png",
  });
}

interface UseNoisyPresetsCheckProps {
  presets: Preset[];
}

export function useNoisyPresetsCheck({ presets }: UseNoisyPresetsCheckProps) {
  const api = useApi();
  const { silencedPresetIds } = useSilencedPresets();
  const { bind, unbind } = useWebsocket();
  const prevShouldNoiseRef = useRef(false);
  const stopKeepAliveRef = useRef<(() => void) | undefined>(undefined);

  const noisyPresets = presets?.filter(
    (preset) => preset.is_noisy && !silencedPresetIds.includes(preset.id)
  );

  const swrKey =
    api.isReady() && noisyPresets?.length
      ? noisyPresets.map((p) => p.id)
      : null;

  const { data: shouldDoNoise, mutate } = useSWR(
    swrKey,
    async () => {
      for (const noisyPreset of noisyPresets) {
        const celRules = [
          "status == 'firing' && deleted == false && dismissed == false",
          noisyPreset.options.find((opt) => opt.label === "CEL")?.value,
        ];
        const query: AlertsQuery = {
          cel: celRules.filter(Boolean).map((cel) => `(${cel})`).join(" && "),
          limit: 0,
          offset: 0,
        };

        const { count } = await api.post("/alerts/query", query);
        if (count) {
          return true;
        }
      }
      return false;
    },
    {
      // Keep polling even when the tab is hidden — Chrome throttles setInterval in
      // background tabs, but this ensures we catch up within ~1 minute at worst.
      // The Pusher listener below provides near-instant updates regardless.
      refreshInterval: 5000,
      refreshWhenHidden: true,
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
    }
  );

  // Trigger an immediate re-check when the backend emits a poll-presets event.
  // Pusher uses WebSocket, which Chrome never throttles in background tabs, so
  // this fires the noise check in real-time regardless of tab visibility.
  const handlePollPresets = useCallback(() => {
    mutate();
  }, [mutate]);

  useEffect(() => {
    bind("poll-presets", handlePollPresets);
    return () => {
      unbind("poll-presets", handlePollPresets);
    };
  }, [bind, unbind, handlePollPresets]);

  // Re-check immediately when the tab becomes visible again.
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        mutate();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [mutate]);

  // Start the silent audio keep-alive on the first user gesture (required by
  // Chrome's autoplay policy). Once started, an active AudioContext tells
  // Chrome not to throttle the tab's timers even when it's in the background.
  useEffect(() => {
    const handleFirstGesture = () => {
      if (!stopKeepAliveRef.current) {
        stopKeepAliveRef.current = startSilentAudioKeepAlive();
      }
      // Only need this once
      window.removeEventListener("pointerdown", handleFirstGesture);
      window.removeEventListener("keydown", handleFirstGesture);
    };

    window.addEventListener("pointerdown", handleFirstGesture, { once: true });
    window.addEventListener("keydown", handleFirstGesture, { once: true });

    return () => {
      window.removeEventListener("pointerdown", handleFirstGesture);
      window.removeEventListener("keydown", handleFirstGesture);
      stopKeepAliveRef.current?.();
      stopKeepAliveRef.current = undefined;
    };
  }, []);

  // Request notification permission once on mount so we can alert the user
  // when the tab is in the background.
  useEffect(() => {
    requestNotificationPermission();
  }, []);

  // Show a browser notification when the alert state transitions to noisy
  // while the user is on a different tab (audio is blocked by Chrome then).
  useEffect(() => {
    const isNowNoisy = !!shouldDoNoise;
    const wasNoisy = prevShouldNoiseRef.current;
    prevShouldNoiseRef.current = isNowNoisy;

    if (isNowNoisy && !wasNoisy && document.hidden) {
      showAlertNotification();
    }
  }, [shouldDoNoise]);

  return { shouldDoNoise: !!shouldDoNoise };
}
