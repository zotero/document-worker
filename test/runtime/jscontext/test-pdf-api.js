(async function () {
  try {
    function assertPdfBuffer(buf, message) {
      var bytes = new Uint8Array(buf);
      assert(bytes.length > 100, message + ' should return a non-empty PDF');
      assert(String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === '%PDF', message + ' should return PDF bytes');
    }

    var zoteroAnnotations = [{
      id: 'AAAABBBB',
      type: 'highlight',
      color: '#f8c348',
      position: {
        pageIndex: 0,
        rects: [
          [231.284, 402.126, 293.107, 410.142],
          [54, 392.164, 293.107, 400.18],
          [54, 382.201, 293.107, 390.217],
          [54, 372.238, 293.107, 380.254],
          [54, 362.276, 273.955, 370.292]
        ]
      },
      authorName: 'John',
      text: 'We present an alternative compilation technique for dynamically-typed languages that identifies frequently executed loop traces at run-time and then generates machine code on the fly that is specialized for the actual dynamic types occurring on each path through the loop',
      comment: 'Sounds promising',
      dateModified: '2020-02-07T07:24:34.638Z',
      tags: ['tag1']
    }];

    var mendeleyAnnotations = [{
      id: 1,
      type: 'note',
      page: 2,
      x: 446.040241448692,
      y: 657.971830985916
    }, {
      type: 'highlight',
      page: 1,
      rects: [{
        x1: 108.094,
        y1: 257.801,
        x2: 295.598,
        y2: 269.051
      }]
    }];

    var citaviAnnotations = [{
      key: 'B3UENNWP',
      type: 'highlight',
      text: null,
      position: {
        pageIndex: 0,
        rects: [[230.20219999999998, 578.879472, 275.47790585937497, 585.816528]]
      },
      pageLabel: '',
      dateAdded: '2022-02-18T17:24:15',
      dateModified: '2022-02-18T17:24:24',
      tags: [{ name: 'red' }],
      color: '#ff6666'
    }];

    var written = await worker.pdf.writeAnnotations(
      loadPDF('test/fixtures/pdf/full/1.pdf'),
      zoteroAnnotations,
      '',
      dataProvider
    );
    assertPdfBuffer(written, 'pdf.writeAnnotations');

    var deleted = await worker.pdf.deletePages(loadPDF('test/fixtures/pdf/full/1.pdf'), [1], '');
    assertPdfBuffer(deleted, 'pdf.deletePages');

    var rotated = await worker.pdf.rotatePages(loadPDF('test/fixtures/pdf/full/1.pdf'), [0], 90, '');
    assertPdfBuffer(rotated, 'pdf.rotatePages');

    var recognizerData = await worker.pdf.getRecognizerData(
      loadPDF('test/fixtures/pdf/full/1.pdf'),
      '',
      dataProvider
    );
    assert(Array.isArray(recognizerData.pages), 'pdf.getRecognizerData should return pages');
    assert(recognizerData.pages.length > 0, 'pdf.getRecognizerData should return at least one page');

    var mendeley = await worker.pdf.importMendeleyAnnotations(
      loadPDF('test/fixtures/pdf/full/2.pdf'),
      mendeleyAnnotations,
      '',
      dataProvider
    );
    assert(Array.isArray(mendeley), 'pdf.importMendeleyAnnotations should return an array');
    assert(mendeley.length > 0, 'pdf.importMendeleyAnnotations should return annotations');

    var citavi = await worker.pdf.importCitaviAnnotations(
      loadPDF('test/fixtures/pdf/full/2.pdf'),
      citaviAnnotations,
      '',
      dataProvider
    );
    assert(Array.isArray(citavi), 'pdf.importCitaviAnnotations should return an array');
    assert(citavi.length > 0, 'pdf.importCitaviAnnotations should return annotations');

    reportPass();
  }
  catch (e) {
    reportFail(e && e.stack || e);
  }
})();
