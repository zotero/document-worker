(async function () {
  try {
    var buf = loadPDF('test/pdfs/full/1.pdf');
    var result = await worker.getStructure(buf, '', dataProvider);

    assert(result, 'should return a result');
    assert(result.schemaVersion, 'should have schemaVersion');
    assert(Array.isArray(result.pages), 'pages should be array');
    assert(result.pages.length > 0, 'should have pages');
    assert(Array.isArray(result.content), 'content should be array');
    assert(result.content.length > 0, 'should have content blocks');
    assert(result.content[0].type, 'block should have type');

    reportPass();
  }
  catch (e) {
    reportFail(e);
  }
})();
