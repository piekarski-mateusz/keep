import { Preset } from "@/entities/presets/model";
// Using dynamic import to avoid hydration issues with react-player
import dynamic from "next/dynamic";
import clsx from "clsx";
import { useNoisyPresetsCheck } from "../model/useNoisyPresetsCheck";

const ReactPlayer = dynamic(() => import("react-player"), { ssr: false });

interface PresetsNoiseProps {
  presets: Preset[];
}

export const PresetsNoise = ({ presets }: PresetsNoiseProps) => {
  const { shouldDoNoise } = useNoisyPresetsCheck({ presets });

  return (
    <div
      data-testid="noisy-presets-audio-player"
      className={clsx("absolute -z-10", {
        playing: shouldDoNoise,
      })}
    >
      <ReactPlayer
        // TODO: cache the audio file fiercely
        url="/music/alert.mp3"
        playing={shouldDoNoise}
        volume={0.5}
        loop={true}
        width="0"
        height="0"
        playsinline
        className="absolute -z-10"
      />
    </div>
  );
};
