class ZhijiPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(4096);
    this.offset = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    let sourceOffset = 0;
    while (sourceOffset < channel.length) {
      const length = Math.min(
        channel.length - sourceOffset,
        this.buffer.length - this.offset,
      );
      this.buffer.set(
        channel.subarray(sourceOffset, sourceOffset + length),
        this.offset,
      );
      this.offset += length;
      sourceOffset += length;

      if (this.offset === this.buffer.length) {
        const samples = this.buffer;
        this.port.postMessage(samples, [samples.buffer]);
        this.buffer = new Float32Array(4096);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor("zhiji-pcm-capture", ZhijiPcmCaptureProcessor);
