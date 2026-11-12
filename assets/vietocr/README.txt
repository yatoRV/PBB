VietOCR name reader (Lich di lam 3.0, phase 3)
Model: VietOCR vgg_seq2seq, official weights https://vocr.vn/data/vietocr/vgg_seq2seq.pth
  (sha256 0921503a41375a0584268e23ef3d414ea478a8fe8777865c7745d38f2d0bc5db). Code: github.com/pbcquoc/vietocr, Apache-2.0.
  The weights are published by the author with the project; no separate weights license is stated.
Export 25/10/2026: encoder (VGG19-bn + GRU encoder) and one decoder step to ONNX opset 17.
  encoder.onnx = static INT8 QDQ, per-channel Conv weights, calibrated on 30 name cells of the 25/10 pipe photos.
  decoder.onnx = dynamic INT8.
  vocab.txt    = model vocabulary; token id = 4 + index (0 pad, 1 start, 2 end, 3 mask).
Runtime: ONNX Runtime Android 1.23.2 (MIT).
