(async function () {
  try {
    var TEST_SOURCE_HASH = '00000000000000000000000000000000';

    function assertSdtPack(result, type) {
      assert(result && result.buf, type + ' should return a packed result');
      assert(result.buf.byteLength > 100, type + ' pack should be non-empty');
      var bytes = new Uint8Array(result.buf, 0, 8);
      var magic = [0x89, 0x53, 0x44, 0x54, 0x0d, 0x0a, 0x1a, 0x0a];
      for (var i = 0; i < magic.length; i++) {
        assert(bytes[i] === magic[i], type + ' should return SDT pack');
      }
    }

    var pdf = loadPDF('test/fixtures/pdf/full/1.pdf');
    var pdfResult = await worker.getStructuredDocumentText(pdf, {
      contentType: 'application/pdf',
      password: '',
      dataProvider,
      sourceHash: TEST_SOURCE_HASH
    });
    assertSdtPack(pdfResult, 'pdf');

    var epub = loadBytes('test/fixtures/epub/1.epub');
    var epubResult = await worker.getStructuredDocumentText(epub, {
      contentType: 'application/epub+zip',
      sourceHash: TEST_SOURCE_HASH
    });
    assertSdtPack(epubResult, 'epub');

    var snapshot = loadBytes('test/fixtures/snapshot/1.html');
    var snapshotResult = await worker.getStructuredDocumentText(snapshot, {
      contentType: 'text/html',
      sourceHash: TEST_SOURCE_HASH
    });
    assertSdtPack(snapshotResult, 'snapshot');

    reportPass();
  }
  catch (e) {
    reportFail(e);
  }
})();
