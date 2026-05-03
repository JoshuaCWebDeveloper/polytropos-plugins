/**
 * Discord Voice Connection Manager
 * Handles joining, leaving, listening, and speaking in voice channels
 *
 * Features:
 * - Barge-in: Stops speaking when user starts talking
 * - Auto-reconnect heartbeat: Keeps connection alive
 * - Streaming STT: Real-time transcription with Deepgram
 */

import { Readable } from "node:stream";
import type { DiscordVoiceConfig } from "./config.js";
import type { TTSResult } from "./tts.js";
import type { STTResult } from "./stt.js";
import { requireRuntimeModule } from "./runtime-deps.js";

import { SPEAK_COOLDOWN_VAD_MS, SPEAK_COOLDOWN_PROCESSING_MS, getRmsThreshold } from "./constants.js";
import { createSTTProvider, type STTProvider } from "./stt.js";
import { createTTSProvider, type TTSProvider } from "./tts.js";

const emojiRegex = requireRuntimeModule<() => RegExp>("emoji-regex");
const prism = requireRuntimeModule<any>("prism-media");
const discordVoice = requireRuntimeModule<any>("@discordjs/voice");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  EndBehaviorType,
  StreamType,
} = discordVoice;

type VoiceConnection = any;
type AudioPlayer = any;
type AudioReceiveStream = any;

interface VoiceBasedChannel {
  id: string;
  guildId?: string;
  name: string;
  guild: {
    id: string;
    name?: string;
    voiceAdapterCreator: unknown;
    members?: {
      me?: {
        voice?: {
          channelId?: string | null;
        };
      };
    };
  };
}

function pcmToWavBuffer(pcmBuffer: Buffer, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcmBuffer.length;
  const headerSize = 44;
  const fileSize = headerSize + dataSize - 8;

  const buffer = Buffer.alloc(headerSize + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(fileSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  pcmBuffer.copy(buffer, headerSize);
  return buffer;
}

/** Create Discord audio resource from TTS result; PCM is converted to WAV for playback */
function createResourceFromTTSResult(result: TTSResult): ReturnType<typeof createAudioResource> {
  if (result.format === "opus") {
    return createAudioResource(Readable.from(result.audioBuffer), {
      inputType: StreamType.OggOpus,
    });
  }
  if (result.format === "pcm") {
    return createAudioResource(Readable.from(pcmToWavBuffer(result.audioBuffer, result.sampleRate)));
  }
  return createAudioResource(Readable.from(result.audioBuffer));
}

/** Detect quota/rate-limit errors that warrant trying a fallback TTS provider */
function isRetryableTtsError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();
  return (
    lower.includes("quota_exceeded") ||
    lower.includes("rate limit") ||
    lower.includes("rate_limit") ||
    /"status":\s*"quota_exceeded"/.test(msg) ||
    /\b401\b/.test(msg) ||
    /\b429\b/.test(msg) ||
    /\b503\b/.test(msg)
  );
}

/** Detect STT errors that warrant trying a fallback (quota, rate limit, connection, Wyoming unreachable) */
function isRetryableSttError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();
  return (
    lower.includes("quota_exceeded") ||
    lower.includes("rate limit") ||
    lower.includes("rate_limit") ||
    /\b401\b/.test(msg) ||
    /\b429\b/.test(msg) ||
    /\b503\b/.test(msg) ||
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("etimedout") ||
    lower.includes("connection") ||
    lower.includes("timeout") ||
    lower.includes("unreachable") ||
    lower.includes("wyoming")
  );
}

import { StreamingSTTManager, createStreamingSTTProvider } from "./streaming-stt.js";
import { createStreamingTTSProvider, type StreamingTTSProvider } from "./streaming-tts.js";

interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug?(msg: string): void;
}

interface UserAudioState {
  chunks: Buffer[];
  lastActivityMs: number;
  isRecording: boolean;
  silenceTimer?: ReturnType<typeof setTimeout>;
  opusStream?: AudioReceiveStream;
  decoder?: any;

  // Incremental STT: sequential transcription queue
  // Pending transcription promise (undefined means queue is empty)
  sttPendingPromise?: Promise<void>;
  // Array of completed transcript chunks
  transcriptChunks: string[];

  // Chunking bookkeeping for time-based fallback
  totalPcmBytes: number;
  sttChunkStartBytes: number;
  forceChunkTimer?: ReturnType<typeof setInterval>;

  // Audio overlap carry-forward (prepended to next chunk)
  carryAudio?: Buffer;

  // Index into `chunks` where the next STT chunk starts (kept for compatibility/debug)
  sttChunkStartIdx: number;

  // Timestamp (ms) when Discord reported speaking ended (VAD end)
  lastSpeechEndAt?: number;

  // Barge-in gating: when the bot is speaking, Discord can emit false speaking.start events
  // (e.g. user mic picking up bot audio). We "arm" barge-in and only stop playback once
  // we have enough buffered audio that looks like real speech.
  bargeInArmed?: boolean;
  bargeInTimer?: ReturnType<typeof setTimeout>;
}

export interface VoiceSession {
  guildId: string;
  channelId: string;
  channelName?: string;
  connection: VoiceConnection;
  player: AudioPlayer;
  userAudioStates: Map<string, UserAudioState>;
  speaking: boolean;
  processing: boolean; // Lock to prevent concurrent processing
  lastSpokeAt?: number; // Timestamp when bot finished speaking (for cooldown)
  startedSpeakingAt?: number; // Timestamp when bot started speaking (for echo suppression)
  thinkingPlayer?: AudioPlayer; // Separate player for thinking sound
  heartbeatInterval?: ReturnType<typeof setInterval>;
  lastHeartbeat?: number;
  reconnecting?: boolean;

  /** Trace info for the current voice turn (best-effort; used for detailed timing logs) */
  trace?: {
    id: string;
    userId: string;
    vadEndAt?: number;
    silenceWaitMs?: number;
    processStartAt?: number;
    sttStartAt?: number;
    sttEndAt?: number;
    transcribedAt?: number;
    agentStartAt?: number;
    agentEndAt?: number;
    ttsStartAt?: number;
    ttsAudioReadyAt?: number;
    playbackStartAt?: number;
  };

  /** Fallback TTS provider to use for rest of session (set after primary fails with quota/rate limit) */
  fallbackTtsProvider?: "openai" | "elevenlabs" | "deepgram" | "polly" | "kokoro" | "edge";
  /** Fallback STT provider to use for rest of session (set after primary fails) */
  fallbackSttProvider?:
    | "whisper"
    | "gpt4o-mini"
    | "gpt4o-transcribe"
    | "gpt4o-transcribe-diarize"
    | "deepgram"
    | "local-whisper"
    | "wyoming-whisper";
  /** Set when agent used discord_voice speak tool – skip speaking returned text to avoid duplicate */
  spokeViaToolThisRun?: boolean;
  /** Dedupe: skip processing same transcript within this window (ms) */
  lastProcessedTranscript?: string;
  lastProcessedTranscriptAt?: number;
  /** Runtime overrides via /discord_voice set-* commands */
  sttProviderOverride?: VoiceSession["fallbackSttProvider"];
  ttsProviderOverride?: VoiceSession["fallbackTtsProvider"];
  modelOverride?: string;
  thinkLevelOverride?: "off" | "low" | "medium" | "high";
}

export class VoiceConnectionManager {
  private sessions: Map<string, VoiceSession> = new Map();
  private config: DiscordVoiceConfig;
  private sttProvider: STTProvider | null = null;
  private streamingSTT: StreamingSTTManager | null = null;
  private ttsProvider: TTSProvider | null = null;
  private streamingTTS: StreamingTTSProvider | null = null;
  private logger: Logger;
  private onTranscript: (userId: string, guildId: string, channelId: string, text: string) => Promise<string>;

  // Heartbeat configuration (can be overridden via config.heartbeatIntervalMs)
  private readonly DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds
  private readonly HEARTBEAT_TIMEOUT_MS = 60_000; // 60 seconds before reconnect
  private readonly MAX_RECONNECT_ATTEMPTS = 3;

  private get HEARTBEAT_INTERVAL_MS(): number {
    return this.config.heartbeatIntervalMs ?? this.DEFAULT_HEARTBEAT_INTERVAL_MS;
  }

  constructor(
    config: DiscordVoiceConfig,
    logger: Logger,
    onTranscript: (userId: string, guildId: string, channelId: string, text: string) => Promise<string>,
  ) {
    this.config = config;
    this.logger = logger;
    this.onTranscript = onTranscript;
  }

  /**
   * Mark that the agent spoke via discord_voice tool during this transcript run.
   * processRecording will skip speaking the returned text to avoid duplicate playback.
   */
  markSpokeViaTool(guildId: string): void {
    const session = this.sessions.get(guildId);
    if (session) {
      session.spokeViaToolThisRun = true;
      this.logger.debug?.("[discord-voice] Agent spoke via discord_voice tool, will skip final speak");
    }
  }

  /**
   * Initialize providers lazily
   */
  private ensureProviders(): void {
    if (!this.sttProvider) {
      this.sttProvider = createSTTProvider(this.config);
    }
    if (!this.ttsProvider) {
      this.ttsProvider = createTTSProvider(this.config);
    }
    // Initialize streaming TTS (always, for lower latency)
    if (!this.streamingTTS) {
      this.streamingTTS = createStreamingTTSProvider(this.config);
    }
    // Initialize streaming STT if using Deepgram with streaming enabled
    if (!this.streamingSTT && this.config.sttProvider === "deepgram" && this.config.streamingSTT) {
      this.streamingSTT = createStreamingSTTProvider(this.config, this.logger);
    }
  }

  /**
   * Check if the bot has an active voice session in a guild
   */
  hasSession(guildId: string): boolean {
    return this.sessions.has(guildId);
  }

  /**
   * Join a voice channel
   */
  async join(channel: VoiceBasedChannel): Promise<VoiceSession> {
    const guildId = channel.guildId ?? channel.guild.id;
    const existingSession = this.sessions.get(guildId);
    if (existingSession) {
      if (existingSession.channelId === channel.id) {
        return existingSession;
      }
      // Leave current channel first
      await this.leave(guildId);
    }

    this.ensureProviders();

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false, // We need to hear users
      selfMute: false,
      // Prevent crashes when optional @snazzah/davey is not installed.
      // Users can re-enable DAVE by installing the dependency and removing this override.
      daveEncryption: false,
    });

    const player = createAudioPlayer();
    connection.subscribe(player);

    const session: VoiceSession = {
      guildId,
      channelId: channel.id,
      channelName: channel.name,
      connection,
      player,
      userAudioStates: new Map(),
      speaking: false,
      processing: false,
      lastHeartbeat: Date.now(),
    };

    this.sessions.set(guildId, session);

    // Wait for the connection to be ready
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
      this.logger.info(`[discord-voice] Joined voice channel ${channel.name} in ${channel.guild.name ?? channel.guild.id}`);
    } catch (error) {
      connection.destroy();
      this.sessions.delete(guildId);
      throw new Error(`Failed to join voice channel: ${error}`);
    }

    // Start listening to users
    this.startListening(session);

    // Start heartbeat for connection health monitoring
    this.startHeartbeat(session);

    // Handle connection state changes
    this.setupConnectionHandlers(session, channel);

    return session;
  }

  /**
   * Setup connection event handlers for auto-reconnect
   */
  private setupConnectionHandlers(session: VoiceSession, channel: VoiceBasedChannel): void {
    const connection = session.connection;

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      if (session.reconnecting) return;

      this.logger.warn(`[discord-voice] Disconnected from voice channel in ${channel.guild.name ?? channel.guild.id}`);

      try {
        // Try to reconnect within 5 seconds
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        this.logger.info(`[discord-voice] Reconnecting to voice channel...`);
      } catch {
        // Connection is not recovering, attempt manual reconnect
        await this.attemptReconnect(session, channel);
      }
    });

    connection.on(VoiceConnectionStatus.Ready, () => {
      session.lastHeartbeat = Date.now();
      session.reconnecting = false;
      this.logger.info(`[discord-voice] Connection ready for ${channel.name}`);
    });

    connection.on("error", (error: Error) => {
      this.logger.error(`[discord-voice] Connection error: ${error.message}`);
    });
  }

  /**
   * Attempt to reconnect to voice channel
   */
  private async attemptReconnect(session: VoiceSession, channel: VoiceBasedChannel, attempt = 1): Promise<void> {
    if (attempt > this.MAX_RECONNECT_ATTEMPTS) {
      this.logger.error(`[discord-voice] Max reconnection attempts reached, giving up`);
      await this.leave(session.guildId);
      return;
    }

    session.reconnecting = true;
    this.logger.info(`[discord-voice] Reconnection attempt ${attempt}/${this.MAX_RECONNECT_ATTEMPTS}`);

    try {
      // Destroy old connection
      session.connection.destroy();

      // Wait before reconnecting (exponential backoff)
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));

      // Create new connection
      const newConnection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guildId ?? channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
        // Prevent crashes when optional @snazzah/davey is not installed.
        daveEncryption: false,
      });

      const newPlayer = createAudioPlayer();
      newConnection.subscribe(newPlayer);

      // Update session
      session.connection = newConnection;
      session.player = newPlayer;

      // Wait for ready
      await entersState(newConnection, VoiceConnectionStatus.Ready, 20_000);

      session.reconnecting = false;
      session.lastHeartbeat = Date.now();

      // Restart listening
      this.startListening(session);

      // Setup handlers for new connection
      this.setupConnectionHandlers(session, channel);

      this.logger.info(`[discord-voice] Reconnected successfully`);
    } catch (error) {
      this.logger.error(
        `[discord-voice] Reconnection failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.attemptReconnect(session, channel, attempt + 1);
    }
  }

  /**
   * Start heartbeat monitoring for session
   */
  private startHeartbeat(session: VoiceSession): void {
    // Clear any existing heartbeat
    if (session.heartbeatInterval) {
      clearInterval(session.heartbeatInterval);
    }

    session.heartbeatInterval = setInterval(() => {
      const now = Date.now();
      const connectionState = session.connection.state.status;

      // Update heartbeat if connection is healthy
      if (connectionState === VoiceConnectionStatus.Ready) {
        session.lastHeartbeat = now;
        this.logger.debug?.(`[discord-voice] Heartbeat OK for guild ${session.guildId}`);
      } else if (session.lastHeartbeat && now - session.lastHeartbeat > this.HEARTBEAT_TIMEOUT_MS) {
        // Connection has been unhealthy for too long
        this.logger.warn(`[discord-voice] Heartbeat timeout, connection state: ${connectionState}`);

        // Don't attempt reconnect if already doing so
        if (!session.reconnecting) {
          // Trigger reconnection by destroying and rejoining
          this.logger.info(`[discord-voice] Triggering reconnection due to heartbeat timeout`);
          session.connection.destroy();
        }
      }
    }, this.HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Leave a voice channel
   */
  async leave(guildId: string): Promise<boolean> {
    const session = this.sessions.get(guildId);
    if (!session) {
      return false;
    }

    // Clear heartbeat
    if (session.heartbeatInterval) {
      clearInterval(session.heartbeatInterval);
    }

    // Clear all user timers and streams
    for (const state of session.userAudioStates.values()) {
      if (state.silenceTimer) {
        clearTimeout(state.silenceTimer);
      }
      if (state.opusStream) {
        state.opusStream.destroy();
      }
      if (state.decoder) {
        state.decoder.destroy();
      }
    }

    // Close streaming STT sessions
    if (this.streamingSTT) {
      for (const userId of session.userAudioStates.keys()) {
        this.streamingSTT.closeSession(userId);
      }
    }

    session.connection.destroy();
    this.sessions.delete(guildId);
    this.logger.info(`[discord-voice] Left voice channel in guild ${guildId}`);
    return true;
  }

  /**
   * Start listening to voice in the channel
   */
  private startListening(session: VoiceSession): void {
    const receiver = session.connection.receiver;

    receiver.speaking.on("start", (userId: string) => {
      if (!this.isUserAllowed(userId)) {
        return;
      }

      // Ignore audio during cooldown period (prevents echo from triggering)
      if (session.lastSpokeAt && Date.now() - session.lastSpokeAt < SPEAK_COOLDOWN_VAD_MS) {
        this.logger.debug?.(`[discord-voice] Ignoring speech during cooldown (likely echo)`);
        return;
      }

      this.logger.debug?.(`[discord-voice] User ${userId} started speaking`);

      // ═══════════════════════════════════════════════════════════════
      // BARGE-IN / ECHO SUPPRESSION
      // Discord's voice detection can't distinguish between the user talking
      // and echo from the bot's own audio playback. We disable barge-in while
      // speaking to prevent the bot from interrupting itself.
      // ═══════════════════════════════════════════════════════════════
      if (session.speaking) {
        // If barge-in is enabled, don't stop immediately.
        // Discord can emit false "speaking" events when the user's mic picks up the bot audio.
        // Arm a short gate and only stop once we have buffered audio that passes RMS threshold.
        if (!this.config.bargeIn) {
          this.logger.debug?.(`[discord-voice] Ignoring speech while bot is speaking (echo suppression)`);
          return;
        }

        // Ensure state exists so we can buffer audio for gating.
        let state = session.userAudioStates.get(userId);
        if (!state) {
          state = {
            chunks: [],
            lastActivityMs: Date.now(),
            isRecording: false,
            transcriptChunks: [],
            totalPcmBytes: 0,
            sttChunkStartBytes: 0,
            sttChunkStartIdx: 0,
          };
          session.userAudioStates.set(userId, state);
        }

        // If we already armed barge-in for this user, do nothing.
        if (state.bargeInArmed) {
          return;
        }

        state.bargeInArmed = true;

        // Start recording to gather evidence, but keep bot speaking for now.
        if (!state.isRecording) {
          state.isRecording = true;
          state.chunks = [];
          this.startRecording(session, userId);
        }

        // Clear any prior timer and schedule a gate check.
        if (state.bargeInTimer) clearTimeout(state.bargeInTimer);

        const confirmMs = 500; // gate window (ms)
        state.bargeInTimer = setTimeout(() => {
          try {
            const audioBuffer = Buffer.concat(state?.chunks ?? []);
            const durationMs = audioBuffer.length / 2 / 48;
            const rms = this.calculateRMS(audioBuffer);
            const minRMS = getRmsThreshold(this.config.vadSensitivity);

            // For barge-in confirmation we want to be responsive, so don't require full minAudioMs.
            // A short, loud enough segment is enough to confirm the user is really talking.
            if (durationMs >= 250 && rms >= minRMS) {
              this.logger.debug?.(
                `[discord-voice] Barge-in confirmed (dur=${Math.round(durationMs)}ms rms=${Math.round(rms)}>=${minRMS}); stopping bot speech`,
              );
              this.stopSpeaking(session);
              // Keep recording; normal end-of-speech will process.
            } else {
              this.logger.debug?.(
                `[discord-voice] Barge-in rejected (dur=${Math.round(durationMs)}ms rms=${Math.round(rms)}<${minRMS}); treating as echo`,
              );
              // Stop and discard this recording.
              state.chunks = [];
              state.isRecording = false;
              if (state.opusStream) {
                state.opusStream.destroy();
                state.opusStream = undefined;
              }
              if (state.decoder) {
                state.decoder.destroy();
                state.decoder = undefined;
              }
            }
          } finally {
            if (state) {
              state.bargeInArmed = false;
              state.bargeInTimer = undefined;
            }
          }
        }, confirmMs);

        // We handled the speaking-start event under gating.
        return;
      }

      if (session.processing) {
        // While processing a request, don't start new recordings
        // Clear any accumulated streaming transcripts to prevent stale text
        if (this.streamingSTT) {
          this.streamingSTT.closeSession(userId);
        }
        this.logger.debug?.(`[discord-voice] Ignoring speech while processing`);
        return;
      }

      let state = session.userAudioStates.get(userId);
      if (!state) {
        state = {
          chunks: [],
          lastActivityMs: Date.now(),
          isRecording: false,
          transcriptChunks: [],
          totalPcmBytes: 0,
          sttChunkStartBytes: 0,
          sttChunkStartIdx: 0,
        };
        session.userAudioStates.set(userId, state);
      }

      // Clear any existing silence timer
      if (state.silenceTimer) {
        clearTimeout(state.silenceTimer);
        state.silenceTimer = undefined;
      }

      if (!state.isRecording) {
        state.isRecording = true;
        state.chunks = [];
        state.transcriptChunks = [];
        state.totalPcmBytes = 0;
        state.sttChunkStartBytes = 0;
        state.carryAudio = undefined;
        state.sttChunkStartIdx = 0;

        // Time-based fallback chunking when VAD doesn't yield pauses
        const FORCE_CHUNK_AFTER_MS = 3500;
        const FORCE_CHUNK_CHECK_EVERY_MS = 500;
        if (state.forceChunkTimer) clearInterval(state.forceChunkTimer);
        state.forceChunkTimer = setInterval(() => {
          try {
            if (!state.isRecording) return;
            // Only force a chunk if we have >= FORCE_CHUNK_AFTER_MS of unsent audio
            const unsentBytes = state.totalPcmBytes - state.sttChunkStartBytes;
            const unsentMs = unsentBytes / 2 / 48;
            if (unsentMs >= FORCE_CHUNK_AFTER_MS) {
              // Queue STT for current buffered audio without waiting for VAD end
              this.queueIncrementalStt(session, userId, state, "time");
            }
          } catch {
            // ignore
          }
        }, FORCE_CHUNK_CHECK_EVERY_MS);

        this.startRecording(session, userId);
      }

      state.lastActivityMs = Date.now();
    });

    receiver.speaking.on("end", (userId: string) => {
      if (!this.isUserAllowed(userId)) {
        return;
      }

      this.logger.debug?.(`[discord-voice] User ${userId} stopped speaking`);

      const state = session.userAudioStates.get(userId);
      if (!state || !state.isRecording) {
        return;
      }

      state.lastActivityMs = Date.now();
      state.lastSpeechEndAt = state.lastActivityMs;

      // Queue STT for the utterance chunk that just ended
      this.queueIncrementalStt(session, userId, state, "vad");

      // Clear previous timer – multiple "end" events must not spawn multiple processRecording calls
      if (state.silenceTimer) {
        clearTimeout(state.silenceTimer);
        state.silenceTimer = undefined;
      }

      // Set silence timer to process the recording
      state.silenceTimer = setTimeout(async () => {
        state.silenceTimer = undefined;
        const now = Date.now();
        const silenceWaitMs = state.lastSpeechEndAt ? now - state.lastSpeechEndAt : undefined;
        session.trace = session.trace ?? { id: `t${now.toString(36)}`, userId };
        session.trace.vadEndAt = state.lastSpeechEndAt;
        session.trace.silenceWaitMs = silenceWaitMs;
        this.logger.info(
          `[discord-voice][trace ${session.trace.id}] silence_wait_ms=${silenceWaitMs ?? -1} threshold_ms=${this.config.silenceThresholdMs}`,
        );
        if (state.isRecording) {
          const chunksToProcess = [...state.chunks];
          state.isRecording = false;
          state.chunks = [];

          // Clean up streams
          if (state.opusStream) {
            state.opusStream.destroy();
            state.opusStream = undefined;
          }
          if (state.decoder) {
            state.decoder.destroy();
            state.decoder = undefined;
          }

          if (chunksToProcess.length > 0) {
            // Stop time-based forcing now that we're finalizing
            if (state.forceChunkTimer) {
              clearInterval(state.forceChunkTimer);
              state.forceChunkTimer = undefined;
            }

            // Make sure we queue the final (possibly short) tail
            this.queueIncrementalStt(session, userId, state, "final");

            // Wait for the transcription chain to complete
            if (state.sttPendingPromise) {
              await state.sttPendingPromise;
              state.sttPendingPromise = undefined;
            }

            // Combine all transcript chunks
            const fullTranscript = state.transcriptChunks.join(" ").trim();
            state.transcriptChunks = [];
            state.totalPcmBytes = 0;
            state.sttChunkStartBytes = 0;
            state.carryAudio = undefined;
            state.sttChunkStartIdx = 0;

            await this.processRecording(session, userId, chunksToProcess, fullTranscript);
          } else {
            if (state.forceChunkTimer) {
              clearInterval(state.forceChunkTimer);
              state.forceChunkTimer = undefined;
            }
            state.sttPendingPromise = undefined;
            state.transcriptChunks = [];
            state.totalPcmBytes = 0;
            state.sttChunkStartBytes = 0;
            state.carryAudio = undefined;
            state.sttChunkStartIdx = 0;
          }
        }
      }, this.config.silenceThresholdMs);
    });
  }

  /**
   * Queue a sequential STT transcription for the currently buffered audio.
   *
   * Uses VAD chunking when available, and a time-based fallback (see forceChunkTimer)
   * to avoid waiting for VAD pauses.
   *
   * When Wyoming returns timestamped segments (Transcript.context.segments), we can
   * "commit" audio+text only up to the last full sentence boundary and carry the
   * remainder audio forward as overlap.
   */
  private queueIncrementalStt(
    session: VoiceSession,
    userId: string,
    state: UserAudioState,
    reason: "vad" | "time" | "final",
  ): void {
    // Determine the unsent audio chunks since last STT queue
    const newChunks = state.chunks.slice(state.sttChunkStartIdx);
    const unsentBytes = state.totalPcmBytes - state.sttChunkStartBytes;
    if (newChunks.length === 0 || unsentBytes <= 0) return;

    const carry = state.carryAudio;
    // Consume carry for this queued chunk
    state.carryAudio = undefined;

    const chunkAudio = carry ? Buffer.concat([carry, Buffer.concat(newChunks)]) : Buffer.concat(newChunks);
    const chunkDurationMs = chunkAudio.length / 2 / 48;

    // Mark as sent
    state.sttChunkStartIdx = state.chunks.length;
    state.sttChunkStartBytes = state.totalPcmBytes;

    // Thresholding:
    // - For VAD/time we require a longer chunk to reduce noise transcriptions
    // - For final we allow shorter tail so short utterances still get captured
    const minMs = reason === "final" ? 300 : 800;
    if (chunkDurationMs < minMs) {
      this.logger.debug?.(
        `[discord-voice] incremental_stt_skip reason=${reason} audio_ms=${Math.round(chunkDurationMs)} (<${minMs}ms)`,
      );
      // Put carry back so we don't lose the audio tail
      state.carryAudio = chunkAudio;
      return;
    }

    const effectivePrimaryStt = this.getEffectiveSttProvider(session);
    const chunkIdx = state.transcriptChunks.length;

    const TICK_MS = 10; // whisper.cpp segment tick is typically 10ms
    const OVERLAP_PAD_MS = 200;

    const startStt = async (): Promise<void> => {
      this.logger.info(
        `[discord-voice] incremental_stt_start chunk=${chunkIdx} reason=${reason} audio_ms=${Math.round(chunkDurationMs)} provider=${effectivePrimaryStt}`,
      );
      const t0 = Date.now();

      let r: Awaited<ReturnType<typeof this.tryTranscribeWithProvider>> | null = null;
      try {
        r = await this.tryTranscribeWithProvider(chunkAudio, 48000, effectivePrimaryStt);
      } catch (err) {
        this.logger.warn(
          `[discord-voice] incremental_stt_fail chunk=${chunkIdx} ms=${Date.now() - t0} err=${err instanceof Error ? err.message : String(err)}`,
        );

        // Try fallbacks if error is retryable
        const fallbackList = this.config.sttFallbackProviders ?? [];
        if (fallbackList.length > 0 && isRetryableSttError(err)) {
          this.logger.warn(`[discord-voice] Primary STT failed, trying fallbacks: [${fallbackList.join(", ")}]`);
          for (const provider of fallbackList) {
            try {
              r = await this.tryTranscribeWithProvider(chunkAudio, 48000, provider);
              if (r.text?.trim()) {
                if (effectivePrimaryStt !== "wyoming-whisper") {
                  session.fallbackSttProvider = provider;
                  this.logger.info(`[discord-voice] Using fallback STT: ${provider} (session will stay on fallback)`);
                } else {
                  this.logger.info(`[discord-voice] Using fallback STT: ${provider}`);
                }
                break;
              }
            } catch (fbErr) {
              this.logger.warn(
                `[discord-voice] Fallback STT ${provider} failed: ${fbErr instanceof Error ? fbErr.message : String(fbErr)}`,
              );
            }
          }
        }

        // If still no result, carry audio forward
        if (!r || !r.text) {
          state.carryAudio = chunkAudio;
          return;
        }
      }

      const rr = r;
      if (!rr) {
        state.carryAudio = chunkAudio;
        return;
      }

      let text = rr.text?.trim() ?? "";
      if (text === "[BLANK_AUDIO]" || text === "(blank audio)" || text === "[SILENCE]") text = "";

      // Sentence boundary commit using timestamped segments (Option A)
      let committedText = text;
      let cutEndMs: number | null = null;

      const segs = rr.segments;
      if (segs && segs.length > 0) {
        const ends: number[] = segs.map((s) => s.t1 * TICK_MS);
        const chunkMs = chunkDurationMs;

        const isSentenceEnd = (t: string): boolean => {
          const s = t.trim();
          return /[.!?][\"'\)\]]*$/.test(s);
        };

        const candidates = segs
          .map((s, i) => (isSentenceEnd(s.text) ? i : -1))
          .filter((i) => i >= 0);

        if (candidates.length > 0) {
          const last = candidates[candidates.length - 1];
          if (last === undefined) return;
          let chosen: number = last;
          let chosenEnd = ends[chosen] ?? chunkMs;

          // Heuristic: if the last segment ends right at the end of the chunk, it's often just
          // whisper punctuation normalization. Prefer the previous sentence if available.
          if (
            candidates.length >= 2 &&
            chosen === segs.length - 1 &&
            chosenEnd > chunkMs - 200
          ) {
            const prev = candidates[candidates.length - 2];
            if (prev !== undefined) {
              chosen = prev;
              chosenEnd = ends[chosen] ?? chosenEnd;
            }
          }

          committedText = segs
            .slice(0, chosen + 1)
            .map((s) => s.text.trim())
            .filter(Boolean)
            .join(" ")
            .trim();
          cutEndMs = Math.max(0, Math.min(chosenEnd, chunkMs));
        }
      }

      if (committedText) state.transcriptChunks.push(committedText);

      // Carry remainder audio forward as overlap
      if (cutEndMs !== null) {
        const bytesPerMs = 48 * 2; // 48kHz * 16-bit mono
        const cutBytes = Math.floor(cutEndMs * bytesPerMs);
        const padBytes = Math.floor(OVERLAP_PAD_MS * bytesPerMs);
        const start = Math.max(0, cutBytes - padBytes);
        const remainder = chunkAudio.slice(start);
        // Only carry if there's meaningful remainder
        if (remainder.length > 0 && remainder.length < chunkAudio.length) {
          state.carryAudio = remainder;
        }
      }

      this.logger.info(
        `[discord-voice] incremental_stt_end chunk=${chunkIdx} ms=${Date.now() - t0} chars=${committedText.length} cutMs=${cutEndMs ?? -1} segments=${segs?.length ?? 0} text=${JSON.stringify(committedText.slice(0, 80))}`,
      );
    };

    // Chain after any existing pending transcription
    if (state.sttPendingPromise) {
      state.sttPendingPromise = state.sttPendingPromise.then(startStt);
    } else {
      state.sttPendingPromise = startStt();
    }
  }

  /**
   * Stop any current speech output (for barge-in)
   */
  private stopSpeaking(session: VoiceSession): void {
    // Stop main player
    if (session.player.state.status !== AudioPlayerStatus.Idle) {
      session.player.stop(true);
    }

    // Stop thinking player if active
    if (session.thinkingPlayer && session.thinkingPlayer.state.status !== AudioPlayerStatus.Idle) {
      session.thinkingPlayer.stop(true);
      session.thinkingPlayer.removeAllListeners();
      session.thinkingPlayer = undefined;
    }

    session.speaking = false;
  }

  /**
   * Start recording audio from a user
   */
  private startRecording(session: VoiceSession, userId: string): void {
    const state = session.userAudioStates.get(userId);
    if (!state) return;

    const opusStream = session.connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.Manual,
      },
    });

    // Handle stream errors to prevent crashes
    opusStream.on("error", (error: Error) => {
      this.logger.error(`[discord-voice] AudioReceiveStream error for user ${userId}: ${error.message}`);
    });

    state.opusStream = opusStream;

    // Decode Opus to PCM
    const decoder = new prism.opus.Decoder({
      rate: 48000,
      channels: 1,
      frameSize: 960,
    });

    state.decoder = decoder;
    opusStream.pipe(decoder);

    // If streaming STT is available and enabled, use it
    const useStreaming = this.streamingSTT && this.config.sttProvider === "deepgram" && this.config.streamingSTT;

    if (useStreaming && this.streamingSTT) {
      // Create streaming session for this user
      this.streamingSTT.getOrCreateSession(userId, (text, isFinal) => {
        if (isFinal) {
          this.logger.debug?.(`[discord-voice] Streaming transcript (final): "${text}"`);
        } else {
          this.logger.debug?.(`[discord-voice] Streaming transcript (interim): "${text}"`);
        }
      });

      decoder.on("data", (chunk: Buffer) => {
        if (state.isRecording) {
          // Send to streaming STT
          this.streamingSTT?.sendAudio(userId, chunk);

          // Also buffer for fallback/debugging
          state.chunks.push(chunk);
          state.totalPcmBytes += chunk.length;
          state.lastActivityMs = Date.now();

          // Check max recording length
          const totalSize = state.chunks.reduce((sum, c) => sum + c.length, 0);
          const durationMs = totalSize / 2 / 48; // 16-bit samples at 48kHz
          if (durationMs >= this.config.maxRecordingMs) {
            this.logger.debug?.(`[discord-voice] Max recording length reached for user ${userId}`);
            state.isRecording = false;

            if (state.opusStream) {
              state.opusStream.destroy();
              state.opusStream = undefined;
            }
            if (state.decoder) {
              state.decoder.destroy();
              state.decoder = undefined;
            }

            this.processRecording(session, userId, [...state.chunks]);
            state.chunks = [];
          }
        }
      });
    } else {
      // Batch mode - just buffer audio
      decoder.on("data", (chunk: Buffer) => {
        if (state.isRecording) {
          state.chunks.push(chunk);
          state.totalPcmBytes += chunk.length;
          state.lastActivityMs = Date.now();

          // Check max recording length
          const totalSize = state.chunks.reduce((sum, c) => sum + c.length, 0);
          const durationMs = totalSize / 2 / 48; // 16-bit samples at 48kHz
          if (durationMs >= this.config.maxRecordingMs) {
            this.logger.debug?.(`[discord-voice] Max recording length reached for user ${userId}`);
            state.isRecording = false;

            if (state.opusStream) {
              state.opusStream.destroy();
              state.opusStream = undefined;
            }
            if (state.decoder) {
              state.decoder.destroy();
              state.decoder = undefined;
            }

            this.processRecording(session, userId, [...state.chunks]);
            state.chunks = [];
          }
        }
      });
    }

    decoder.on("end", () => {
      this.logger.debug?.(`[discord-voice] Decoder stream ended for user ${userId}`);
    });

    decoder.on("error", (error: Error) => {
      this.logger.error(`[discord-voice] Decoder error for user ${userId}: ${error.message}`);
    });
  }

  /**
   * Process recorded audio through STT and get response
   */
  private async processRecording(
    session: VoiceSession,
    userId: string,
    chunks: Buffer[],
    incrementalTranscript?: string,
  ): Promise<void> {
    if (!this.sttProvider || !this.ttsProvider) {
      return;
    }

    // Skip if already speaking (prevents overlapping responses)
    if (session.speaking) {
      this.logger.debug?.(`[discord-voice] Skipping processing - already speaking`);
      return;
    }

    // Skip if already processing another request (prevents duplicate responses)
    if (session.processing) {
      this.logger.debug?.(`[discord-voice] Skipping processing - already processing another request`);
      return;
    }

    // Cooldown after speaking to prevent echo/accidental triggers
    if (session.lastSpokeAt && Date.now() - session.lastSpokeAt < SPEAK_COOLDOWN_PROCESSING_MS) {
      this.logger.debug?.(`[discord-voice] Skipping processing - in cooldown period after speaking`);
      return;
    }

    const audioBuffer = Buffer.concat(chunks);

    // Skip very short recordings (likely noise) - check BEFORE setting processing lock
    const durationMs = audioBuffer.length / 2 / 48; // 16-bit samples at 48kHz
    if (durationMs < this.config.minAudioMs) {
      this.logger.debug?.(
        `[discord-voice] Skipping short recording (${Math.round(durationMs)}ms < ${this.config.minAudioMs}ms) for user ${userId}`,
      );
      return;
    }

    // Calculate RMS amplitude to filter out quiet sounds (keystrokes, background noise)
    const rms = this.calculateRMS(audioBuffer);
    const minRMS = getRmsThreshold(this.config.vadSensitivity);
    if (rms < minRMS) {
      this.logger.debug?.(
        `[discord-voice] Skipping quiet audio (RMS ${Math.round(rms)} < ${minRMS}) for user ${userId}`,
      );
      return;
    }

    // Set processing lock AFTER passing all filters
    session.processing = true;
    session.spokeViaToolThisRun = false;

    // DEBUG: dump raw PCM to a WAV so we can listen to what the bot actually received.
    // This is the fastest way to tell whether the issue is upstream audio quality vs STT.
    try {
      // Lazy import to avoid overhead unless we actually process audio
      const fs = await import("node:fs");
      const path = await import("node:path");

      const outDir = path.join(process.env["HOME"] || "/tmp", ".clawdbot", "discord-voice-debug");
      fs.mkdirSync(outDir, { recursive: true });

      const wavPath = path.join(outDir, "last-utterance.wav");

      const sampleRate = 48000;
      const channels = 1;
      const bitsPerSample = 16;
      const byteRate = sampleRate * channels * (bitsPerSample / 8);
      const blockAlign = channels * (bitsPerSample / 8);
      const dataSize = audioBuffer.length;
      const fileSizeMinus8 = 36 + dataSize;

      const header = Buffer.alloc(44);
      header.write("RIFF", 0);
      header.writeUInt32LE(fileSizeMinus8, 4);
      header.write("WAVE", 8);
      header.write("fmt ", 12);
      header.writeUInt32LE(16, 16); // PCM fmt chunk size
      header.writeUInt16LE(1, 20); // PCM format
      header.writeUInt16LE(channels, 22);
      header.writeUInt32LE(sampleRate, 24);
      header.writeUInt32LE(byteRate, 28);
      header.writeUInt16LE(blockAlign, 32);
      header.writeUInt16LE(bitsPerSample, 34);
      header.write("data", 36);
      header.writeUInt32LE(dataSize, 40);

      fs.writeFileSync(wavPath, Buffer.concat([header, audioBuffer]));
      this.logger.info(`[discord-voice] Wrote debug WAV: ${wavPath}`);
    } catch (e) {
      this.logger.warn(
        `[discord-voice] Failed to write debug WAV: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    // Begin a new trace for this turn
    const traceId = `t${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    session.trace = {
      id: traceId,
      userId,
      vadEndAt: session.trace?.vadEndAt,
      silenceWaitMs: session.trace?.silenceWaitMs,
      processStartAt: Date.now(),
    };

    this.logger.info(
      `[discord-voice][trace ${traceId}] process_start audio_ms=${Math.round(durationMs)} rms=${Math.round(rms)} user=${userId}`,
    );

    try {
      let transcribedText = "";
      const fallbackList = this.config.sttFallbackProviders ?? [];

      const effectivePrimaryStt = this.getEffectiveSttProvider(session);
      const primaryIsWyoming = effectivePrimaryStt === "wyoming-whisper";

      const tryFallbacks = async (): Promise<string> => {
        for (const provider of fallbackList) {
          try {
            const r = await this.tryTranscribeWithProvider(audioBuffer, 48000, provider);
            if (r.text?.trim()) {
              if (!primaryIsWyoming) {
                session.fallbackSttProvider = provider;
                this.logger.info(`[discord-voice] Using fallback STT: ${provider} (session will stay on fallback)`);
              } else {
                this.logger.info(`[discord-voice] Using fallback STT: ${provider}`);
              }
              return r.text;
            }
          } catch (fbErr) {
            this.logger.warn(
              `[discord-voice] Fallback STT ${provider} failed: ${fbErr instanceof Error ? fbErr.message : String(fbErr)}`,
            );
          }
        }
        return "";
      };

      // STT timing
      session.trace.sttStartAt = Date.now();
      this.logger.info(`[discord-voice][trace ${session.trace.id}] stt_start provider=${effectivePrimaryStt}`);

      // --- Incremental STT path: if we have a full transcript from sequential transcription, use it ---
      if (incrementalTranscript) {
        transcribedText = incrementalTranscript.trim();
        this.logger.info(
          `[discord-voice][trace ${session.trace.id}] incremental_stt_done chars=${transcribedText.length} text=${JSON.stringify(transcribedText.slice(0, 120))}`,
        );

        // If incremental STT produced nothing, fall back to batch
        if (!transcribedText) {
          this.logger.info(
            `[discord-voice][trace ${session.trace.id}] incremental_stt_empty, falling back to batch`,
          );
          try {
            const r = await this.tryTranscribeWithProvider(audioBuffer, 48000, effectivePrimaryStt);
            transcribedText = r.text ?? "";
          } catch (batchErr) {
            if (fallbackList.length > 0 && isRetryableSttError(batchErr)) {
              this.logger.warn(`[discord-voice] Batch STT failed, trying fallbacks: [${fallbackList.join(", ")}]`);
              transcribedText = await tryFallbacks();
            } else throw batchErr;
          }
        }
      } else {
        // --- Legacy batch STT path (no incremental transcriptions available) ---

        // Wyoming-whisper: always try primary first (service may be temporarily down). Others: stick to fallback once switched.
        if (session.fallbackSttProvider && !primaryIsWyoming) {
          try {
            const r = await this.tryTranscribeWithProvider(audioBuffer, 48000, session.fallbackSttProvider);
            transcribedText = r.text ?? "";
            if (!transcribedText?.trim()) session.fallbackSttProvider = undefined;
          } catch (fbErr) {
            this.logger.warn(
              `[discord-voice] Session fallback STT failed: ${fbErr instanceof Error ? fbErr.message : String(fbErr)}`,
            );
            session.fallbackSttProvider = undefined;
          }
        }

        if (!transcribedText) {
          // Use effective primary (override or config); streaming only when primary is Deepgram
          if (this.streamingSTT && effectivePrimaryStt === "deepgram" && this.config.streamingSTT) {
            transcribedText = this.streamingSTT.finalizeSession(userId);

            // Fallback to batch if streaming didn't capture anything
            if (!transcribedText || transcribedText.trim().length === 0) {
              this.logger.debug?.(`[discord-voice] Streaming empty, falling back to batch STT`);
              try {
                const r = await this.tryTranscribeWithProvider(audioBuffer, 48000, "deepgram");
                transcribedText = r.text ?? "";
              } catch (batchErr) {
                if (fallbackList.length > 0 && isRetryableSttError(batchErr)) {
                  this.logger.warn(`[discord-voice] Primary STT failed, trying fallbacks: [${fallbackList.join(", ")}]`);
                  transcribedText = await tryFallbacks();
                } else throw batchErr;
              }
            }
          } else {
            try {
              const r = await this.tryTranscribeWithProvider(audioBuffer, 48000, effectivePrimaryStt);
              transcribedText = r.text ?? "";
            } catch (batchErr) {
              if (fallbackList.length > 0 && isRetryableSttError(batchErr)) {
                this.logger.warn(`[discord-voice] Primary STT failed, trying fallbacks: [${fallbackList.join(", ")}]`);
                transcribedText = await tryFallbacks();
              } else throw batchErr;
            }
          }
        }
      }

      session.trace.sttEndAt = Date.now();
      this.logger.info(
        `[discord-voice][trace ${session.trace.id}] stt_end ms=${session.trace.sttEndAt - (session.trace.sttStartAt ?? session.trace.sttEndAt)}`,
      );

      if (!transcribedText || transcribedText.trim().length === 0) {
        this.logger.debug?.(`[discord-voice] Empty transcription for user ${userId}`);
        session.processing = false;
        return;
      }

      // Dedupe: skip if same transcript was just processed (e.g. duplicate "end" events, gateway relay)
      const trimmed = transcribedText.trim();
      const now = Date.now();
      const dedupeWindowMs = 5000;
      if (
        session.lastProcessedTranscript === trimmed &&
        session.lastProcessedTranscriptAt !== undefined &&
        session.lastProcessedTranscriptAt !== null &&
        now - session.lastProcessedTranscriptAt < dedupeWindowMs
      ) {
        this.logger.debug?.(`[discord-voice] Skipping duplicate transcript (same text within ${dedupeWindowMs}ms)`);
        session.processing = false;
        return;
      }
      session.lastProcessedTranscript = trimmed;
      session.lastProcessedTranscriptAt = now;

      session.trace.transcribedAt = Date.now();
      const sttInfo = this.getSttProviderInfo(session);
      this.logger.info(
        `[discord-voice] Transcribed: "${transcribedText}" (STT: ${sttInfo.provider} / ${sttInfo.model})`,
      );
      this.logger.info(
        `[discord-voice][trace ${session.trace.id}] transcribed chars=${transcribedText.length}`,
      );

      // Play looping thinking sound while processing (if enabled)
      const stopThinking = await this.startThinkingLoop(session);

      let response: string;
      try {
        // Get response from agent
        session.trace.agentStartAt = Date.now();
        this.logger.info(`[discord-voice][trace ${session.trace.id}] agent_start`);
        response = await this.onTranscript(userId, session.guildId, session.channelId, transcribedText);
        session.trace.agentEndAt = Date.now();
        this.logger.info(
          `[discord-voice][trace ${session.trace.id}] agent_end ms=${session.trace.agentEndAt - (session.trace.agentStartAt ?? session.trace.agentEndAt)} resp_chars=${response?.length ?? 0}`,
        );
      } finally {
        // Always stop thinking sound, even on error
        stopThinking();
        const delayMs = this.config.thinkingSound?.stopDelayMs ?? 50;
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }

      if (!response || response.trim().length === 0) {
        session.processing = false;
        return;
      }

      // Skip if agent already spoke via discord_voice tool (avoids duplicate playback)
      // Use current session from map: agent's auto-join may have replaced session during run
      const currentSession = this.sessions.get(session.guildId) ?? session;
      if (currentSession.spokeViaToolThisRun) {
        this.logger.debug?.("[discord-voice] Skipping speak – agent already spoke via discord_voice tool");
        session.processing = false;
        return;
      }

      // Ensure main player is subscribed before speaking
      session.connection.subscribe(session.player);

      // Synthesize and play response
      session.trace.ttsStartAt = Date.now();
      this.logger.info(`[discord-voice][trace ${session.trace.id}] tts_pipeline_start provider=${this.getEffectiveTtsProvider(session)}`);
      await this.speak(session.guildId, response);
      this.logger.info(`[discord-voice][trace ${session.trace.id}] speak_done`);
    } catch (error) {
      this.logger.error(
        `[discord-voice] Error processing audio: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      session.processing = false;
    }
  }

  /**
   * Try to transcribe using a specific STT provider (for fallback)
   */
  private async tryTranscribeWithProvider(
    audioBuffer: Buffer,
    sampleRate: number,
    provider:
      | "whisper"
      | "gpt4o-mini"
      | "gpt4o-transcribe"
      | "gpt4o-transcribe-diarize"
      | "deepgram"
      | "local-whisper"
      | "wyoming-whisper",
  ): Promise<STTResult> {
    const t0 = Date.now();
    const overrideConfig = { ...this.config, sttProvider: provider };
    const stt = createSTTProvider(overrideConfig);
    try {
      const r = await stt.transcribe(audioBuffer, sampleRate);
      const t1 = Date.now();
      this.logger.info(
        `[discord-voice] stt_provider_done provider=${provider} ms=${t1 - t0} chars=${r.text?.length ?? 0} segments=${r.segments?.length ?? 0}`,
      );
      return r;
    } catch (e) {
      const t1 = Date.now();
      this.logger.warn(
        `[discord-voice] STT provider failed: provider=${provider} ms=${t1 - t0} err=${e instanceof Error ? e.message : String(e)}`,
      );
      throw e;
    }
  }

  /**
   * Try to get an audio resource using a specific TTS provider (for fallback)
   */
  private async tryGetResourceWithProvider(
    text: string,
    provider: "openai" | "elevenlabs" | "deepgram" | "polly" | "kokoro" | "edge",
  ): Promise<ReturnType<typeof createAudioResource> | null> {
    const overrideConfig = { ...this.config, ttsProvider: provider };
    const fallbackTts = createTTSProvider(overrideConfig);
    const fallbackStreaming = createStreamingTTSProvider(overrideConfig);

    // Try streaming first (OpenAI/ElevenLabs only)
    if (fallbackStreaming) {
      try {
        const streamResult = await fallbackStreaming.synthesizeStream(text);
        if (streamResult.format === "opus") {
          return createAudioResource(streamResult.stream, { inputType: StreamType.OggOpus });
        }
        return createAudioResource(streamResult.stream);
      } catch {
        // Fall through to batch
      }
    }

    // Batch
    const ttsResult = await fallbackTts.synthesize(text);
    return createResourceFromTTSResult(ttsResult);
  }

  /**
   * Speak text in the voice channel
   */
  async speak(guildId: string, rawText: string): Promise<void> {
    const session = this.sessions.get(guildId);
    if (!session) {
      throw new Error("Not connected to voice channel");
    }

    // If thinking sound is playing (e.g. agent called discord_voice speak tool during run),
    // stop it and re-subscribe to main player so our audio is actually heard
    if (session.thinkingPlayer && session.thinkingPlayer.state.status !== AudioPlayerStatus.Idle) {
      session.thinkingPlayer.removeAllListeners();
      session.thinkingPlayer.stop(true);
      session.thinkingPlayer = undefined;
      session.connection.subscribe(session.player);
    }

    // Strip emojis before TTS when noEmojiHint is set (avoids Kokoro/others reading them aloud)
    const text =
      this.config.noEmojiHint !== false
        ? rawText
            .replace(emojiRegex(), "")
            .replace(/\s{2,}/g, " ")
            .trim()
        : rawText;

    this.ensureProviders();

    if (!this.streamingTTS && !this.ttsProvider) {
      throw new Error("TTS provider not initialized");
    }

    session.speaking = true;
    session.startedSpeakingAt = Date.now();

    const waitForPlayback = () =>
      new Promise<void>((resolve) => {
        const onIdle = () => {
          session.speaking = false;
          session.lastSpokeAt = Date.now();
          session.player.off(AudioPlayerStatus.Idle, onIdle);
          session.player.off("error", onError);
          resolve();
        };
        const onError = (error: Error) => {
          this.logger.error(`[discord-voice] Playback error: ${error.message}`);
          session.speaking = false;
          session.lastSpokeAt = Date.now();
          session.player.off(AudioPlayerStatus.Idle, onIdle);
          session.player.off("error", onError);
          resolve();
        };
        session.player.on(AudioPlayerStatus.Idle, onIdle);
        session.player.on("error", onError);
      });
    try {
      let resource: ReturnType<typeof createAudioResource> | null = null;
      const fallbackList = this.config.ttsFallbackProviders ?? [];

      const tryFallbacks = async (): Promise<ReturnType<typeof createAudioResource> | null> => {
        for (const provider of fallbackList) {
          try {
            const r = await this.tryGetResourceWithProvider(text, provider);
            if (r) {
              session.fallbackTtsProvider = provider;
              this.logger.info(`[discord-voice] Using fallback TTS: ${provider} (session will stay on fallback)`);
              return r;
            }
          } catch (fbErr) {
            this.logger.warn(
              `[discord-voice] Fallback ${provider} failed: ${fbErr instanceof Error ? fbErr.message : String(fbErr)}`,
            );
          }
        }
        return null;
      };

      // If session already switched to fallback (e.g. quota hit earlier), use it for rest of session
      if (session.fallbackTtsProvider) {
        try {
          resource = await this.tryGetResourceWithProvider(text, session.fallbackTtsProvider);
          if (resource) {
            this.logger.debug?.(`[discord-voice] Using fallback TTS (session): ${session.fallbackTtsProvider}`);
          } else {
            session.fallbackTtsProvider = undefined;
          }
        } catch (fbErr) {
          this.logger.warn(
            `[discord-voice] Session fallback TTS failed: ${fbErr instanceof Error ? fbErr.message : String(fbErr)}`,
          );
          session.fallbackTtsProvider = undefined;
        }
      }

      const effectivePrimaryTts = this.getEffectiveTtsProvider(session);

      // If user overrode TTS provider, try that first
      if (!resource && session.ttsProviderOverride) {
        try {
          resource = await this.tryGetResourceWithProvider(text, effectivePrimaryTts);
        } catch (ovErr) {
          this.logger.warn(
            `[discord-voice] Override TTS ${effectivePrimaryTts} failed: ${ovErr instanceof Error ? ovErr.message : String(ovErr)}`,
          );
        }
      }

      // Try primary: streaming first (OpenAI/ElevenLabs), then batch (only when not already have resource)
      if (
        !resource &&
        this.streamingTTS &&
        (effectivePrimaryTts === "openai" || effectivePrimaryTts === "elevenlabs")
      ) {
        try {
          const streamResult = await this.streamingTTS.synthesizeStream(text);
          if (streamResult.format === "opus") {
            resource = createAudioResource(streamResult.stream, { inputType: StreamType.OggOpus });
          } else {
            resource = createAudioResource(streamResult.stream);
          }
          this.logger.debug?.(`[discord-voice] Using streaming TTS`);
        } catch (streamError) {
          this.logger.warn(
            `[discord-voice] Streaming TTS failed, falling back to buffered: ${streamError instanceof Error ? streamError.message : String(streamError)}`,
          );
          if (fallbackList.length > 0 && isRetryableTtsError(streamError)) {
            this.logger.warn(
              `[discord-voice] Primary TTS failed (quota/rate limit), trying fallbacks: [${fallbackList.join(", ")}]`,
            );
            resource = await tryFallbacks();
          }
        }
      }

      if (!resource) {
        try {
          resource = await this.tryGetResourceWithProvider(text, effectivePrimaryTts);
        } catch (batchError) {
          if (fallbackList.length > 0 && isRetryableTtsError(batchError)) {
            this.logger.warn(
              `[discord-voice] Primary TTS failed (quota/rate limit), trying fallbacks: [${fallbackList.join(", ")}]`,
            );
            resource = await tryFallbacks();
          }
          if (!resource) throw batchError;
        }
      }

      if (!resource) {
        throw new Error("Failed to create audio resource");
      }

      // Trace: resource ready
      if (session.trace?.ttsStartAt) {
        session.trace.ttsAudioReadyAt = Date.now();
        this.logger.info(
          `[discord-voice][trace ${session.trace.id}] tts_audio_ready ms=${session.trace.ttsAudioReadyAt - session.trace.ttsStartAt}`,
        );
      }

      const ttsInfo = this.getTtsProviderInfo(session);
      this.logger.info(
        `[discord-voice] Speaking: "${text.substring(0, 50)}${text.length > 50 ? "..." : ""}" (TTS: ${ttsInfo.provider} / ${ttsInfo.model})`,
      );

      // Trace: playback start (best-effort: when we call player.play)
      if (session.trace) {
        session.trace.playbackStartAt = Date.now();
        const totalMs = session.trace.processStartAt ? session.trace.playbackStartAt - session.trace.processStartAt : undefined;
        this.logger.info(
          `[discord-voice][trace ${session.trace.id}] playback_start total_since_process_ms=${totalMs ?? -1}`,
        );
      }

      session.player.play(resource);
      await waitForPlayback();
    } catch (error) {
      session.speaking = false;
      session.lastSpokeAt = Date.now();
      throw error;
    }
  }

  /**
   * Start looping thinking sound, returns stop function
   * No-op if disabled or file not found
   */
  private async startThinkingLoop(session: VoiceSession): Promise<() => void> {
    const ts = this.config.thinkingSound;
    if (ts?.enabled === false) return () => {};

    let stopped = false;
    try {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { fileURLToPath } = await import("node:url");

      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const pluginRoot = path.resolve(path.join(__dirname, ".."));
      const pathRaw = ts?.path ?? "assets/thinking.mp3";

      // Security: reject absolute paths and path traversal to prevent arbitrary file reads
      if (path.isAbsolute(pathRaw)) {
        this.logger.warn("[discord-voice] Absolute thinking sound paths are not allowed for security reasons");
        return () => {};
      }
      if (pathRaw.includes("..")) {
        this.logger.warn("[discord-voice] Path traversal in thinking sound path is not allowed");
        return () => {};
      }
      const thinkingPath = path.resolve(path.join(pluginRoot, pathRaw));
      if (!thinkingPath.startsWith(pluginRoot)) {
        this.logger.warn("[discord-voice] Thinking sound path resolved outside plugin root");
        return () => {};
      }

      if (!fs.existsSync(thinkingPath)) {
        return () => {};
      }

      const audioData = fs.readFileSync(thinkingPath);
      const volume = typeof ts?.volume === "number" && ts.volume >= 0 && ts.volume <= 1 ? ts.volume : 0.7;

      // Create separate player for thinking sound
      const thinkingPlayer = createAudioPlayer();
      session.thinkingPlayer = thinkingPlayer;
      session.connection.subscribe(thinkingPlayer);

      const playLoop = () => {
        if (stopped || !thinkingPlayer) return;
        const resource = createAudioResource(Readable.from(Buffer.from(audioData)), {
          inlineVolume: true,
        });
        resource.volume?.setVolume(volume);
        thinkingPlayer.play(resource);
      };

      thinkingPlayer.on(AudioPlayerStatus.Idle, playLoop);
      playLoop(); // Start first play

      return () => {
        stopped = true;
        if (thinkingPlayer) {
          thinkingPlayer.removeAllListeners();
          thinkingPlayer.stop(true);
        }
        session.thinkingPlayer = undefined;
        // Re-subscribe main player immediately
        session.connection.subscribe(session.player);
      };
    } catch (error) {
      this.logger.debug?.(
        `[discord-voice] Error starting thinking loop: ${error instanceof Error ? error.message : String(error)}`,
      );
      return () => {
        session.thinkingPlayer = undefined;
        session.connection.subscribe(session.player);
      };
    }
  }

  /**
   * Calculate RMS (Root Mean Square) amplitude of audio buffer
   * Used to filter out quiet sounds like keystrokes and background noise
   */
  private calculateRMS(audioBuffer: Buffer): number {
    // Audio is 16-bit signed PCM
    const samples = audioBuffer.length / 2;
    if (samples === 0) return 0;

    let sumSquares = 0;
    for (let i = 0; i < audioBuffer.length; i += 2) {
      const sample = audioBuffer.readInt16LE(i);
      sumSquares += sample * sample;
    }

    return Math.sqrt(sumSquares / samples);
  }

  /**
   * Check if a user is allowed to use voice
   */
  private isUserAllowed(userId: string): boolean {
    if (this.config.allowedUsers.length === 0) {
      return true;
    }
    return this.config.allowedUsers.includes(userId);
  }

  /**
   * Get session for a guild
   */
  getSession(guildId: string): VoiceSession | undefined {
    return this.sessions.get(guildId);
  }

  /**
   * Get all active sessions
   */
  getAllSessions(): VoiceSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Set runtime overrides for a guild (STT provider, TTS provider, model, think level)
   */
  setVoiceConfig(
    guildId: string,
    overrides: {
      sttProvider?: DiscordVoiceConfig["sttProvider"] | null;
      ttsProvider?: DiscordVoiceConfig["ttsProvider"] | null;
      model?: string | null;
      thinkLevel?: "off" | "low" | "medium" | "high" | null;
    },
  ): boolean {
    const session = this.sessions.get(guildId);
    if (!session) return false;
    if (overrides.sttProvider !== undefined) {
      session.sttProviderOverride = overrides.sttProvider ?? undefined;
    }
    if (overrides.ttsProvider !== undefined) {
      session.ttsProviderOverride = overrides.ttsProvider ?? undefined;
    }
    if (overrides.model !== undefined) {
      session.modelOverride = overrides.model ?? undefined;
    }
    if (overrides.thinkLevel !== undefined) {
      session.thinkLevelOverride = overrides.thinkLevel ?? undefined;
    }
    this.logger.info(
      `[discord-voice] Voice config updated for guild ${guildId}: STT=${session.sttProviderOverride ?? "default"}, TTS=${session.ttsProviderOverride ?? "default"}, model=${session.modelOverride ?? "default"}, think=${session.thinkLevelOverride ?? "default"}`,
    );
    return true;
  }

  /**
   * Reset STT and TTS fallbacks for a guild – next request will try primary providers again
   */
  resetFallbacks(guildId: string): boolean {
    const session = this.sessions.get(guildId);
    if (!session) return false;
    const hadStt = Boolean(session.fallbackSttProvider);
    const hadTts = Boolean(session.fallbackTtsProvider);
    session.fallbackSttProvider = undefined;
    session.fallbackTtsProvider = undefined;
    if (hadStt || hadTts) {
      this.logger.info(`[discord-voice] Reset fallbacks for guild ${guildId} (STT: ${hadStt}, TTS: ${hadTts})`);
    }
    return hadStt || hadTts;
  }

  /**
   * Get effective primary STT provider (override or config)
   */
  getEffectiveSttProvider(session: VoiceSession): typeof this.config.sttProvider {
    return session.sttProviderOverride ?? this.config.sttProvider;
  }

  /**
   * Get effective primary TTS provider (override or config)
   */
  getEffectiveTtsProvider(session: VoiceSession): typeof this.config.ttsProvider {
    return session.ttsProviderOverride ?? this.config.ttsProvider;
  }

  /**
   * Resolve effective STT provider and model string for display
   */
  getSttProviderInfo(session: VoiceSession): { provider: string; model: string } {
    const p = session.fallbackSttProvider ?? session.sttProviderOverride ?? this.config.sttProvider;
    const cfg = this.config;
    let model = "";
    switch (p) {
      case "whisper":
        model = cfg.openai?.whisperModel ?? "whisper-1";
        break;
      case "gpt4o-mini":
      case "gpt4o-transcribe":
      case "gpt4o-transcribe-diarize":
        model = p;
        break;
      case "deepgram":
        model = cfg.deepgram?.model ?? "nova-2";
        break;
      case "local-whisper":
        model = cfg.localWhisper?.model ?? "Xenova/whisper-tiny.en";
        break;
      case "wyoming-whisper": {
        const w = cfg.wyomingWhisper;
        model = w?.uri ?? `${w?.host ?? "127.0.0.1"}:${w?.port ?? 10300}`;
        break;
      }
      default:
        model = p;
    }
    return { provider: p, model };
  }

  /**
   * Resolve effective TTS provider and model/voice string for display
   */
  getTtsProviderInfo(session: VoiceSession): { provider: string; model: string } {
    const p = session.fallbackTtsProvider ?? session.ttsProviderOverride ?? this.config.ttsProvider;
    const cfg = this.config;
    let model = "";
    switch (p) {
      case "openai":
        model = `${cfg.openai?.voice ?? "nova"} (${cfg.openai?.ttsModel ?? "tts-1"})`;
        break;
      case "elevenlabs":
        model = `${cfg.elevenlabs?.voiceId ?? "default"} (${cfg.elevenlabs?.modelId ?? "turbo"})`;
        break;
      case "deepgram":
        model = cfg.deepgram?.ttsModel ?? cfg.deepgram?.model ?? "aura-asteria-en";
        break;
      case "polly":
        model = cfg.polly?.voiceId ?? "Joanna";
        break;
      case "kokoro":
        model = `${cfg.kokoro?.voice ?? "af_heart"} (${cfg.kokoro?.modelId ?? "Kokoro-82M"})`;
        break;
      case "edge":
        model = cfg.edge?.voice ?? "de-DE-KatjaNeural";
        break;
      default:
        model = p;
    }
    return { provider: p, model };
  }

  /**
   * Destroy all connections
   */
  async destroy(): Promise<void> {
    // Close streaming STT
    if (this.streamingSTT) {
      this.streamingSTT.closeAll();
    }

    const guildIds = Array.from(this.sessions.keys());
    for (const guildId of guildIds) {
      await this.leave(guildId);
    }
  }
}
