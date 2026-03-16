const fs = require('fs');
// const pdfWorker = require('../../build/pdf-worker');

const pdfWorker = require('../../src/index');

async function cmapProvider(name) {
  console.log('cmap requested:', name);
  let buf = fs.readFileSync(__dirname + '/../../build/cmaps/' + name + '.bcmap');
  return {
    compressionType: 1,
    cMapData: buf
  };
}

async function main() {
  let buf = fs.readFileSync(__dirname + '/../example.pdf');
  let annotations = await pdfWorker.importAnnotations(buf, [], '', cmapProvider);
  console.log(annotations);

  let fulltext = await pdfWorker.getFulltext(buf, 1, '', cmapProvider);
  console.log(fulltext);

  annotations = [{
    type: 'note',
    id: 'zotero:12345/5FG7Q3V1',
    position: {
      pageIndex: 0,
      rects: [[100, 100, 120, 120]]
    },
    color: '#FF0000',
    comment: 'A test note',
    authorName: 'John',
    dateModified: '2019-04-19T08:21:13.011Z',
    tags: []
  }];

  try {
    buf = await pdfWorker.writeAnnotations(buf, annotations);
  }
  catch (e) {
    console.log(e);
  }
  fs.writeFileSync(__dirname + '/../example-out.pdf', Buffer.from(buf), 'binary');
}

main();
