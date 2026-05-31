import { Config } from "@remotion/cli/config";

// H.264 MP4, transparent-safe pixel format, decent quality for hero clips.
Config.setVideoImageFormat("jpeg");
Config.setCodec("h264");
Config.setCrf(20);
// Strip audio — these are silent ambient clips.
Config.setMuted(true);
Config.setOverwriteOutput(true);
