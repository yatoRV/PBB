Base OCR engine of the web version (replaces Google ML Kit text recognition of the Android app).
Chosen by measurement on the APK's own ground-truth photos: see docs/DO-OCR.md.

paddle/  PaddleOCR PP-OCRv5 mobile models, ONNX exports published by RapidOCR
         (https://www.modelscope.cn/models/RapidAI/RapidOCR, files under onnx/PP-OCRv5/ and paddle/PP-OCRv5/).
         Model weights: PaddlePaddle/PaddleOCR (https://github.com/PaddlePaddle/PaddleOCR), Apache License 2.0.
         ONNX conversion: RapidAI/RapidOCR (https://github.com/RapidAI/RapidOCR), Apache License 2.0.
         Files are unchanged; SHA-256:
  4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae  ch_PP-OCRv5_det_mobile.onnx   (4,819,576 bytes)
  c3461add59bb4323ecba96a492ab75e06dda42467c9e3d0c18db5d1d21924be8  en_PP-OCRv5_rec_mobile.onnx   (7,872,351 bytes)
  e025a66d31f327ba0c232e03f407ae8d105e1e709e7ccb3f408aa778c24e70d6  ppocrv5_en_dict.txt           (1,416 bytes)

         Default recognizer: official PaddlePaddle ONNX export
         (https://huggingface.co/PaddlePaddle/latin_PP-OCRv5_mobile_rec_onnx, revision 89d3a50e2c27e2e7cceeab0e944c25c807d5db4f,
         files inference.onnx and inference.yml renamed), Apache License 2.0; SHA-256:
  7888113072263cb471b93f66dd5e2ad70548dc526fa1ace760d0d973dd121498  latin_PP-OCRv5_mobile_rec.onnx  (8,042,023 bytes)
  0bbe984570f597af3638e50bdf2e8276f3ab26a61966096538b3b0d1849f5c84  latin_PP-OCRv5_mobile_rec.yml   (6,817 bytes)

tesseract/  Tesseract 4.0.0 best_int data as packaged by tesseract.js (@tesseract.js-data/eng@1.0.0, vie@1.0.0),
         Apache License 2.0 (alternative engine, js/ocr/engine.js 'tesseract-eng' / 'tesseract-eng-vie'); SHA-256:
  45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91  eng.traineddata.gz  (2,952,873 bytes)
  2284f610f262a1b19ec8df9f196b9ff6ce38ddb4a66329e998941df4b8961c8d  vie.traineddata.gz  (1,423,003 bytes)

Apache License 2.0: https://www.apache.org/licenses/LICENSE-2.0
