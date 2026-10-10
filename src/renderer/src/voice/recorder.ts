import { resampleTo16k } from '../../../shared/audio'

export interface Recorder {
  stop(): void
}

/**
 * Captures the microphone and hands `onSamples` ~100 ms chunks of 16 kHz
 * mono Int16 audio. (A ScriptProcessorNode rather than an AudioWorklet: the
 * page's CSP allows no blob: scripts, and this runs fine in Electron.)
 */
export async function startRecorder(onSamples: (samples: Int16Array) => void): Promise<Recorder> {
  const stream = await navigator.mediaDevices.getUserMedia({
    // Nothing plays while dictating, so echo cancellation has nothing to cancel;
    // and its voice-processing mode on macOS is the likeliest thing to carry
    // audio over between one capture and the next.
    audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
  })
  const context = new AudioContext()
  const source = context.createMediaStreamSource(stream)
  const processor = context.createScriptProcessor(4096, 1, 1)
  processor.onaudioprocess = (e) => {
    // The buffer is reused by the browser, so resampling copies it out.
    onSamples(resampleTo16k(e.inputBuffer.getChannelData(0), context.sampleRate))
  }
  // A processor only runs when connected onward; its output stays silent.
  source.connect(processor)
  processor.connect(context.destination)

  return {
    stop() {
      processor.onaudioprocess = null
      source.disconnect()
      processor.disconnect()
      for (const track of stream.getTracks()) track.stop()
      void context.close()
    }
  }
}
