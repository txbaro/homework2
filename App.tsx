import { Audio } from "expo-av";
import * as FileSystem from "expo-file-system/legacy";
import Constants from "expo-constants";
import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

const appExtra =
  (Constants.expoConfig?.extra as Record<string, string> | undefined) ??
  // Fallbacks for different Expo runtime manifests
  (Constants as { manifest?: { extra?: Record<string, string> } }).manifest
    ?.extra ??
  (Constants as { manifest2?: { extra?: Record<string, string> } }).manifest2
    ?.extra ??
  {};

const ASSEMBLYAI_API_KEY = appExtra.assemblyaiApiKey ?? "";
const GENIUS_ACCESS_TOKEN = appExtra.geniusAccessToken ?? "";
const RAPIDAPI_KEY = appExtra.rapidApiKey ?? "";

const LANGUAGE_OPTIONS = [
  { label: "Vietnamese", value: "vi" },
  { label: "English", value: "en" },
  { label: "Spanish", value: "es" },
  { label: "Japanese", value: "ja" },
  { label: "Korean", value: "ko" },
];

type SongResult = {
  id: number | string; // Shazam có thể trả về id dạng string
  title: string;
  artist: string;
  fullTitle: string;
  songUrl: string;
  imageUrl?: string;
  previewUrl?: string;
  source: "shazam" | "genius"; // Đổi "audd" thành "shazam"
};

type HistoryItem = {
  id: string;
  transcript: string;
  cleaned: string;
  result?: SongResult;
  createdAt: string;
};

const RECORDING_PRESET: Audio.RecordingOptions = {
  isMeteringEnabled: true,
  android: {
    extension: ".wav",
    outputFormat: Audio.AndroidOutputFormat.DEFAULT,
    audioEncoder: Audio.AndroidAudioEncoder.DEFAULT,
    sampleRate: 44100,
    numberOfChannels: 1,
    bitRate: 128000,
  },
  ios: {
    extension: ".wav",
    audioQuality: Audio.IOSAudioQuality.MAX,
    sampleRate: 44100,
    numberOfChannels: 1,
    bitRate: 128000,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: {
    mimeType: "audio/webm",
    bitsPerSecond: 128000,
  },
};
const CHUNK_MS = 8000;
const VU_MIN_DB = -60;
const VU_MAX_DB = -10;

export default function App() {
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [transcriptText, setTranscriptText] = useState("");
  const [cleanedText, setCleanedText] = useState("");
  const [songResult, setSongResult] = useState<SongResult | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [language, setLanguage] = useState(LANGUAGE_OPTIONS[0].value);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [vuLevel, setVuLevel] = useState(0);
  const [chunkCount, setChunkCount] = useState(0);
  const [candidates, setCandidates] = useState<
    Array<{
      id: string;
      title: string;
      artist: string;
      score: number;
      source: string;
      result: SongResult;
    }>
  >([]);
  const [bestScore, setBestScore] = useState(0);
  const bestScoreRef = useRef(0);
  const [previewSound, setPreviewSound] = useState<Audio.Sound | null>(null);
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
  const previewSoundRef = useRef<Audio.Sound | null>(null);

  const chunkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeSessionRef = useRef(0);
  const isStoppingRef = useRef(false);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const chunkIndexRef = useRef(0);

  const hasKeys = useMemo(() => {
    return (
      ASSEMBLYAI_API_KEY.trim().length > 10 &&
      GENIUS_ACCESS_TOKEN.trim().length > 10 &&
      RAPIDAPI_KEY.trim().length > 10 // Đổi thành kiểm tra biến RAPIDAPI_KEY
    );
  }, []);

  useEffect(() => {
    previewSoundRef.current = previewSound;
  }, [previewSound]);

  useEffect(() => {
    return () => {
      if (recordingRef.current) {
        recordingRef.current.stopAndUnloadAsync().catch(() => {});
        recordingRef.current = null;
      }
      if (previewSoundRef.current) {
        previewSoundRef.current.unloadAsync().catch(() => {});
        previewSoundRef.current = null;
      }
      clearChunkTimer();
    };
  }, []);

  const normalizeLyrics = (text: string) => {
    const noPunctuation = text
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
    return noPunctuation;
  };

  const buildSearchQueries = (cleaned: string) => {
    const words = cleaned.split(" ").filter((word) => word.length > 2);
    const uniqueWords = Array.from(new Set(words));
    const topKeywords = [...uniqueWords]
      .sort((a, b) => b.length - a.length)
      .slice(0, 6);
    const firstPhrase = words.slice(0, 8).join(" ");
    const middlePhrase = words
      .slice(
        Math.max(0, Math.floor(words.length / 3)),
        Math.max(8, Math.floor(words.length / 3) + 8),
      )
      .join(" ");

    const queries = [cleaned, firstPhrase, middlePhrase, topKeywords.join(" ")]
      .map((item) => item.trim())
      .filter((item) => item.length >= 6);

    return Array.from(new Set(queries));
  };

  const startRecording = async () => {
    setErrorMessage("");
    setStatusMessage("");
    setSongResult(null);
    setBestScore(0);
    bestScoreRef.current = 0;
    setTranscriptText("");
    setCleanedText("");
    setCandidates([]);
    setChunkCount(0);
    chunkIndexRef.current = 0;
    stopPreview().catch(() => {});

    if (!hasKeys) {
      Alert.alert(
        "Missing API keys",
        "Please add AssemblyAI, Genius, and AudD keys in App.tsx.",
      );
      return;
    }

    try {
      const permission = await Audio.requestPermissionsAsync();
      if (!permission.granted) {
        setErrorMessage("Microphone permission is required.");
        return;
      }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      activeSessionRef.current += 1;
      isStoppingRef.current = false;
      await startChunk(activeSessionRef.current);
      setIsRecording(true);
    } catch (error) {
      setErrorMessage("Cannot start recording. Please try again.");
    }
  };

  const stopRecording = async () => {
    const currentRecording = recordingRef.current;
    if (!currentRecording || isStoppingRef.current) {
      return;
    }

    isStoppingRef.current = true;
    activeSessionRef.current += 1;
    setIsRecording(false);
    setVuLevel(0);
    clearChunkTimer();

    try {
      const stoppedRecording = currentRecording;
      setRecording(null);
      recordingRef.current = null;
      await stoppedRecording.stopAndUnloadAsync();
      const uri = stoppedRecording.getURI();

      if (!uri) {
        setErrorMessage("No audio recorded.");
        return;
      }

      await transcribeAndSearch(uri);
    } catch (error) {
      setErrorMessage("Cannot stop recording. Please try again.");
    } finally {
      isStoppingRef.current = false;
    }
  };

  const clearChunkTimer = () => {
    if (chunkTimerRef.current) {
      clearTimeout(chunkTimerRef.current);
      chunkTimerRef.current = null;
    }
  };

  const startChunk = async (sessionId: number) => {
    const newRecording = new Audio.Recording();
    await newRecording.prepareToRecordAsync({
      ...RECORDING_PRESET,
      isMeteringEnabled: true,
    });

    newRecording.setOnRecordingStatusUpdate((status) => {
      if (!status.isRecording || typeof status.metering !== "number") {
        return;
      }
      const normalized = Math.min(
        1,
        Math.max(0, (status.metering - VU_MIN_DB) / (VU_MAX_DB - VU_MIN_DB)),
      );
      setVuLevel(normalized);
    });
    newRecording.setProgressUpdateInterval(200);

    await newRecording.startAsync();
    setRecording(newRecording);
    recordingRef.current = newRecording;

    clearChunkTimer();
    chunkTimerRef.current = setTimeout(async () => {
      if (isStoppingRef.current || !newRecording) {
        return;
      }
      let uri: string | null = null;
      try {
        await newRecording.stopAndUnloadAsync();
        uri = newRecording.getURI();
      } catch {
        setErrorMessage("Không thể dừng đoạn ghi âm.");
        return;
      }

      if (sessionId !== activeSessionRef.current || isStoppingRef.current) {
        return;
      }

      void startChunk(sessionId);

      if (uri) {
        const nextIndex = chunkIndexRef.current + 1;
        chunkIndexRef.current = nextIndex;
        setChunkCount(nextIndex);
        void transcribeAndSearch(uri, true, nextIndex);
      }
    }, CHUNK_MS);
  };

  const transcribeAndSearch = async (
    uri: string,
    isChunk = false,
    chunkIndex?: number,
  ) => {
    if (!isChunk) {
      setIsTranscribing(true);
    }
    setErrorMessage("");
    const indexLabel = chunkIndex ?? chunkIndexRef.current + 1;
    setStatusMessage(
      isChunk
        ? `Đang nhận diện nhạc (đoạn ${indexLabel})...`
        : "Đang nhận diện nhạc bằng AudD...",
    );

    try {
      const audioResult = await identifySongByAudio(uri);
      if (audioResult) {
        setSongResult(audioResult);
        updateCandidates(audioResult, 0.92);
      }

      if (isChunk) {
        return;
      }

      setStatusMessage("Đang chuyển giọng nói thành văn bản...");
      const uploadUrl = await uploadAudioToAssemblyAI(uri);
      const transcript = await requestTranscript(uploadUrl, language);

      if (!transcript || transcript.trim().length === 0) {
        setErrorMessage(
          "No speech detected. Please speak clearly and try again.",
        );
        setIsTranscribing(false);
        return;
      }

      setTranscriptText(transcript);
      const normalized = normalizeLyrics(transcript);
      setCleanedText(normalized);

      if (normalized.split(" ").length < 4) {
        setErrorMessage(
          "Nhận diện quá ngắn. Hãy nói rõ lời bài hát và giảm tiếng nhạc nền.",
        );
        setIsTranscribing(false);
        return;
      }

      let finalResult = audioResult;
      if (!finalResult) {
        setStatusMessage("Đang tìm bài hát theo lời thoại...");
        finalResult = await searchSong(normalized);
        setSongResult(finalResult);
        if (finalResult) {
          updateCandidates(finalResult, estimateLyricsScore(normalized));
        }
      }

      if (!isChunk) {
        setHistory((prev) => [
          {
            id: String(Date.now()),
            transcript,
            cleaned: normalized,
            result: finalResult ?? undefined,
            createdAt: new Date().toISOString(),
          },
          ...prev,
        ]);
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Processing failed. Please try again.";
      setErrorMessage(message);
    } finally {
      if (!isChunk) {
        setIsTranscribing(false);
      }
      setStatusMessage("");
    }
  };

  const uploadAudioToAssemblyAI = async (uri: string) => {
    const audioResponse = await fetch(uri);
    const audioBlob = await audioResponse.blob();

    const response = await fetch("https://api.assemblyai.com/v2/upload", {
      method: "POST",
      headers: {
        authorization: ASSEMBLYAI_API_KEY,
      },
      body: audioBlob,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Upload failed (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    return data.upload_url as string;
  };

  const requestTranscript = async (audioUrl: string, lang: string) => {
    const response = await fetch("https://api.assemblyai.com/v2/transcript", {
      method: "POST",
      headers: {
        authorization: ASSEMBLYAI_API_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        audio_url: audioUrl,
        language_code: lang,
      }),
    });

    if (!response.ok) {
      throw new Error("Transcript request failed");
    }

    const data = await response.json();
    const id = data.id as string;

    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const statusResponse = await fetch(
        `https://api.assemblyai.com/v2/transcript/${id}`,
        {
          headers: { authorization: ASSEMBLYAI_API_KEY },
        },
      );
      const statusData = await statusResponse.json();

      if (statusData.status === "completed") {
        return statusData.text as string;
      }

      if (statusData.status === "error") {
        throw new Error(statusData.error || "Transcription failed");
      }
    }

    throw new Error("Transcription timeout");
  };

  const identifySongByAudio = async (
    uri: string,
  ): Promise<SongResult | null> => {
    console.log("=== 🚀 BẮT ĐẦU GỌI SHAZAM API ===");
    console.log("1. URI file audio ghi âm được:", uri);

    if (RAPIDAPI_KEY.trim().length < 10) {
      console.error("❌ LỖI: RAPIDAPI_KEY bị thiếu hoặc độ dài không hợp lệ.");
      return null;
    }

    try {
      console.log("2. Đang dùng Expo FileSystem để upload nguyên bản file...");

      // Dùng hàm uploadAsync của hệ thống để tránh lỗi FormData của React Native
      const response = await FileSystem.uploadAsync(
        "https://shazam-core.p.rapidapi.com/v1/tracks/recognize",
        uri,
        {
          fieldName: "file",
          httpMethod: "POST",
          uploadType: 1 as any,
          mimeType: "audio/wav", // Đóng mộc chuẩn WAV không cho iOS cãi
          headers: {
            "X-RapidAPI-Key": RAPIDAPI_KEY,
            "X-RapidAPI-Host": "shazam-core.p.rapidapi.com",
          },
        },
      );

      console.log(`3. Phản hồi từ server: Trạng thái HTTP ${response.status}`);

      // uploadAsync trả về status dưới dạng number và nội dung ở response.body
      if (response.status !== 200) {
        console.error("❌ LỖI TỪ API SHAZAM (HTTP Error):", response.body);
        return null;
      }

      const data = JSON.parse(response.body);
      console.log("4. Dữ liệu Raw JSON trả về (đã parse):");
      console.log(JSON.stringify(data, null, 2));

      if (!data || !data.track) {
        console.warn(
          "⚠️ Shazam nhận được file hoàn chỉnh nhưng không tìm ra nhạc. (Có thể do hát không rõ, quá nhiều tạp âm hoặc chưa có trong database).",
        );
        return null;
      }

      console.log(
        `✅ NHẬN DIỆN THÀNH CÔNG: ${data.track.title} - ${data.track.subtitle}`,
      );

      const track = data.track;
      const previewUrl = track.hub?.actions?.find(
        (action: any) => action.type === "uri" && action.uri?.includes("audio"),
      )?.uri;

      return {
        id: track.key ?? String(Date.now()),
        title: track.title ?? "Unknown title",
        artist: track.subtitle ?? "Unknown artist",
        fullTitle: `${track.subtitle ?? "Unknown"} - ${track.title ?? "Unknown"}`,
        songUrl: track.url ?? "",
        imageUrl: track.images?.coverart ?? track.images?.background,
        previewUrl: previewUrl,
        source: "shazam",
      };
    } catch (error) {
      console.error("❌ CATCH ERROR - Lỗi upload hệ thống:", error);
      return null;
    }
  };

  const estimateLyricsScore = (text: string) => {
    const wordCount = text.split(" ").filter(Boolean).length;
    const score = 0.4 + Math.min(0.45, wordCount * 0.02);
    return Math.min(0.85, Math.max(0.4, score));
  };

  const updateCandidates = (result: SongResult, score: number) => {
    setCandidates((prev) => {
      const key = `${result.title}-${result.artist}`;
      const existing = prev.find((item) => item.id === key);
      const baseScore = Math.max(existing?.score ?? 0, score);
      const nextScore = existing ? Math.min(0.98, baseScore + 0.03) : baseScore;
      const next = [
        {
          id: key,
          title: result.title,
          artist: result.artist,
          score: nextScore,
          source: result.source,
          result,
        },
        ...prev.filter((item) => item.id !== key),
      ]
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

      if (next[0] && next[0].score >= 0.9) {
        setStatusMessage(`Đã có kết quả tự tin: ${next[0].title}`);
      }

      if (next[0] && next[0].score > bestScoreRef.current + 0.05) {
        setSongResult(next[0].result);
        setBestScore(next[0].score);
        bestScoreRef.current = next[0].score;
      }

      return next;
    });
  };

  const searchSong = async (query: string): Promise<SongResult | null> => {
    if (!query || query.length < 3) {
      setErrorMessage("Not enough text to search.");
      return null;
    }

    const queries = buildSearchQueries(query);
    for (const candidate of queries) {
      const response = await fetch(
        `https://api.genius.com/search?q=${encodeURIComponent(candidate)}`,
        {
          headers: {
            Authorization: `Bearer ${GENIUS_ACCESS_TOKEN}`,
          },
        },
      );

      if (!response.ok) {
        throw new Error("Search failed");
      }

      const data = await response.json();
      const hits = data.response?.hits ?? [];
      if (hits.length > 0) {
        const song = hits[0].result;
        return {
          id: song.id,
          title: song.title,
          artist: song.primary_artist?.name ?? "Unknown artist",
          fullTitle: song.full_title,
          songUrl: song.url,
          imageUrl: song.song_art_image_url,
          source: "genius",
        };
      }
    }

    return null;
  };

  const clearResult = () => {
    setTranscriptText("");
    setCleanedText("");
    setSongResult(null);
    setErrorMessage("");
    stopPreview().catch(() => {});
  };

  const stopPreview = async () => {
    if (!previewSound) {
      return;
    }
    try {
      await previewSound.stopAsync();
      await previewSound.unloadAsync();
    } finally {
      setPreviewSound(null);
      setIsPreviewPlaying(false);
    }
  };

  const togglePreview = async () => {
    if (!songResult?.previewUrl) {
      return;
    }
    if (isRecording) {
      setErrorMessage("Đang ghi âm, không thể phát preview.");
      return;
    }
    if (previewSound) {
      const status = await previewSound.getStatusAsync();
      if (status.isLoaded && status.isPlaying) {
        await previewSound.pauseAsync();
        setIsPreviewPlaying(false);
        return;
      }
      await previewSound.playAsync();
      setIsPreviewPlaying(true);
      return;
    }

    setIsPreviewPlaying(true);
    const { sound } = await Audio.Sound.createAsync(
      { uri: songResult.previewUrl },
      { shouldPlay: true },
    );
    sound.setOnPlaybackStatusUpdate((status) => {
      if (!status.isLoaded) {
        return;
      }
      if (status.didJustFinish) {
        setIsPreviewPlaying(false);
      }
    });
    setPreviewSound(sound);
  };

  useEffect(() => {
    if (!previewSound) {
      return;
    }
    previewSound.unloadAsync().catch(() => {});
    setPreviewSound(null);
    setIsPreviewPlaying(false);
  }, [songResult?.previewUrl]);

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>Music Detective</Text>
          <Text style={styles.subtitle}>Nhận diện bài hát thông minh</Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Ngôn ngữ nhận diện</Text>
          <View style={styles.languageRow}>
            {LANGUAGE_OPTIONS.map((option) => (
              <Pressable
                key={option.value}
                onPress={() => setLanguage(option.value)}
                style={[
                  styles.languageChip,
                  language === option.value && styles.languageChipActive,
                ]}
              >
                <Text
                  style={[
                    styles.languageText,
                    language === option.value && styles.languageTextActive,
                  ]}
                >
                  {option.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Ghi âm</Text>
          <View style={styles.controls}>
            <Pressable
              onPress={startRecording}
              disabled={isRecording || isTranscribing}
              style={[
                styles.buttonRecord,
                (isRecording || isTranscribing) && styles.buttonDisabled,
              ]}
            >
              <Text style={styles.buttonText}>Bắt đầu Ghi</Text>
            </Pressable>
            <Pressable
              onPress={stopRecording}
              disabled={!isRecording}
              style={[styles.buttonStop, !isRecording && styles.buttonDisabled]}
            >
              <Text style={styles.buttonText}>Dừng</Text>
            </Pressable>
            <Pressable onPress={clearResult} style={styles.buttonSecondary}>
              <Text style={styles.buttonSecondaryText}>Xóa</Text>
            </Pressable>
          </View>

          {isTranscribing && (
            <View style={styles.loadingRow}>
              <ActivityIndicator color="#FB923C" />
              <Text style={styles.loadingText}>
                {statusMessage || "Đang xử lý..."}
              </Text>
            </View>
          )}

          {!isTranscribing && statusMessage.length > 0 && (
            <View style={styles.loadingRow}>
              <ActivityIndicator color="#22D3EE" />
              <Text style={styles.loadingText}>{statusMessage}</Text>
            </View>
          )}

          {isRecording && (
            <View style={styles.vuWrapper}>
              <Text style={styles.vuLabel}>
                Đang lắng nghe (đoạn {Math.max(chunkCount, 1)})
              </Text>
              <View style={styles.vuTrack}>
                <View
                  style={[
                    styles.vuFill,
                    { width: `${Math.round(vuLevel * 100)}%` },
                  ]}
                />
              </View>
            </View>
          )}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Văn bản nhận diện</Text>
          <View style={styles.cardMuted}>
            <Text style={styles.cardTextMuted}>
              {transcriptText || "Chưa có dữ liệu."}
            </Text>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Văn bản đã làm sạch</Text>
          <View style={styles.cardMuted}>
            <Text style={styles.cardTextMuted}>
              {cleanedText || "Chưa có dữ liệu."}
            </Text>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Kết quả</Text>
          <View style={styles.heroCard}>
            {songResult ? (
              <>
                <Text style={styles.heroResultTitle}>{songResult.title}</Text>
                <Text style={styles.heroResultArtist}>{songResult.artist}</Text>
                {bestScore > 0 && (
                  <Text style={styles.heroConfidence}>
                    Độ tin cậy: {Math.round(bestScore * 100)}%
                  </Text>
                )}
                <View style={styles.sourceBadge}>
                  <Text style={styles.sourceBadgeText}>
                    Nguồn:{" "}
                    {songResult.source === "shazam" ? "Shazam" : "Genius"}
                  </Text>
                </View>
                <Text style={styles.mutedText}>
                  Link: {songResult.songUrl || "Không có"}
                </Text>
                {songResult.previewUrl ? (
                  <Pressable
                    onPress={togglePreview}
                    style={[styles.buttonPreview]}
                  >
                    <Text style={styles.buttonPreviewText}>
                      {isPreviewPlaying ? "Dừng nghe thử" : "Nghe thử 30s"}
                    </Text>
                  </Pressable>
                ) : (
                  <Text style={styles.mutedText}>
                    Bài này không có preview.
                  </Text>
                )}
              </>
            ) : (
              <Text style={styles.cardTextMuted}>
                Không tìm thấy bài hát phù hợp.
              </Text>
            )}
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Gợi ý (live)</Text>
          {candidates.length === 0 ? (
            <Text style={styles.mutedText}>Chưa có gợi ý.</Text>
          ) : (
            candidates.map((item) => {
              return (
                <View key={item.id} style={styles.candidateItem}>
                  <Text style={styles.candidateTitle}>{item.title}</Text>
                  <Text style={styles.candidateArtist}>{item.artist}</Text>
                  <Text style={styles.candidateScore}>
                    Độ tin cậy: {Math.round(item.score * 100)}%
                  </Text>
                  <Text style={styles.candidateSource}>
                    Nguồn: {item.source === "shazam" ? "Shazam" : "Genius"}
                  </Text>
                </View>
              );
            })
          )}
        </View>

        {errorMessage.length > 0 && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{errorMessage}</Text>
          </View>
        )}

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Lịch sử tìm kiếm</Text>
          {history.length === 0 ? (
            <Text style={styles.mutedText}>Chưa có lịch sử.</Text>
          ) : (
            history.map((item) => (
              <View key={item.id} style={styles.historyItem}>
                <Text style={styles.historyDate}>{item.createdAt}</Text>
                <Text style={styles.historyTextMuted}>
                  {item.result ? item.result.fullTitle : "Không tìm thấy"}
                </Text>
              </View>
            ))
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#030712",
  },
  container: {
    padding: 20,
    paddingBottom: 40,
  },
  header: {
    marginBottom: 24,
  },
  title: {
    fontSize: 28,
    color: "#F9FAFB",
    fontWeight: "900",
    letterSpacing: -1,
  },
  subtitle: {
    fontSize: 15,
    color: "#9CA3AF",
    marginTop: 4,
  },
  section: {
    marginTop: 20,
  },
  sectionTitle: {
    color: "#D1D5DB",
    fontWeight: "700",
    fontSize: 13,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: 10,
  },
  languageRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 16,
  },
  languageChip: {
    borderWidth: 1,
    borderColor: "#374151",
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    backgroundColor: "#111827",
  },
  languageChipActive: {
    backgroundColor: "#FB923C",
    borderColor: "#FB923C",
  },
  languageText: {
    color: "#D1D5DB",
    fontSize: 13,
    fontWeight: "500",
  },
  languageTextActive: {
    color: "#030712",
    fontWeight: "700",
  },
  card: {
    backgroundColor: "#111827",
    borderRadius: 16,
    padding: 20,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 5,
  },
  controls: {
    flexDirection: "row",
    gap: 12,
    marginTop: 8,
  },
  buttonText: {
    color: "#030712",
    fontWeight: "800",
    fontSize: 14,
  },
  buttonRecord: {
    backgroundColor: "#FB923C",
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 12,
    shadowColor: "#FB923C",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 4,
  },
  buttonStop: {
    backgroundColor: "#10B981",
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 12,
  },
  buttonSecondary: {
    borderWidth: 1,
    borderColor: "#4B5563",
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 12,
    backgroundColor: "#1F2937",
  },
  buttonSecondaryText: {
    color: "#D1D5DB",
    fontWeight: "600",
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  loadingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 16,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: "#374151",
  },
  loadingText: {
    color: "#F9FAFB",
    fontSize: 14,
  },
  vuWrapper: {
    marginTop: 16,
    padding: 14,
    backgroundColor: "#030712",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#1F2937",
  },
  vuLabel: {
    color: "#F9FAFB",
    fontSize: 13,
    fontWeight: "600",
    marginBottom: 10,
  },
  vuTrack: {
    height: 8,
    backgroundColor: "#1F2937",
    borderRadius: 4,
    overflow: "hidden",
  },
  vuFill: {
    height: "100%",
    backgroundColor: "#22D3EE",
    borderRadius: 4,
  },
  cardMuted: {
    backgroundColor: "#0B0B0F",
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: "#1F2937",
  },
  cardTextMuted: {
    color: "#9CA3AF",
    fontSize: 14,
    lineHeight: 22,
  },
  heroCard: {
    backgroundColor: "#1E293B",
    borderRadius: 16,
    padding: 24,
    borderWidth: 1,
    borderColor: "#334155",
  },
  heroResultTitle: {
    color: "#F9FAFB",
    fontSize: 22,
    fontWeight: "900",
    letterSpacing: -0.5,
  },
  heroResultArtist: {
    color: "#FB923C",
    fontSize: 16,
    fontWeight: "600",
    marginTop: 4,
    marginBottom: 12,
  },
  heroConfidence: {
    color: "#FBBF24",
    fontSize: 13,
    fontWeight: "500",
    marginBottom: 8,
  },
  sourceBadge: {
    alignSelf: "flex-start",
    backgroundColor: "#312E81",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    marginBottom: 12,
  },
  sourceBadgeText: {
    color: "#A5B4FC",
    fontSize: 11,
    fontWeight: "700",
  },
  mutedText: {
    color: "#9CA3AF",
    fontSize: 12,
    marginBottom: 10,
  },
  buttonPreview: {
    marginTop: 14,
    backgroundColor: "#38BDF8",
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: "center",
  },
  buttonPreviewText: {
    color: "#030712",
    fontWeight: "800",
    fontSize: 14,
  },
  errorBox: {
    marginTop: 20,
    padding: 16,
    backgroundColor: "#7F1D1D",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#B91C1C",
  },
  errorText: {
    color: "#FEF2F2",
    fontSize: 14,
    fontWeight: "600",
  },
  historyItem: {
    marginTop: 10,
    padding: 16,
    backgroundColor: "#111827",
    borderRadius: 12,
  },
  historyDate: {
    color: "#6B7280",
    fontSize: 11,
    fontWeight: "500",
    marginBottom: 6,
  },
  historyTextMuted: {
    color: "#D1D5DB",
    fontSize: 14,
    fontWeight: "600",
  },
  candidateItem: {
    marginTop: 10,
    padding: 16,
    backgroundColor: "#0B0B0F",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#1F2937",
  },
  candidateTitle: {
    color: "#F9FAFB",
    fontWeight: "700",
    fontSize: 15,
  },
  candidateArtist: {
    color: "#A5B4FC",
    marginTop: 2,
    fontSize: 13,
  },
  candidateScore: {
    color: "#FBBF24",
    marginTop: 8,
    fontSize: 12,
    fontWeight: "500",
  },
  candidateSource: {
    color: "#6B7280",
    marginTop: 2,
    fontSize: 11,
  },
});
