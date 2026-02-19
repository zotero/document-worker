const path = require('path');
const webpack = require('webpack');

module.exports = {
	entry: ['./src/index.js'],
	output: {
		path: path.join(__dirname, './build'),
		filename: 'worker.js',
		publicPath: '/',
		globalObject: 'this',
		library: {
			name: 'worker',
			type: 'umd',
			umdNamedDefine: true,
		},
	},
	target: 'webworker',
	cache: {
		type: 'filesystem',
	},
	optimization: {
		minimize: false
	},
	plugins: [
		// Ignore objects that only exist on browser and break webpack building process
		new webpack.IgnorePlugin({ resourceRegExp: /^(canvas|fs|https|url|http)$/u })
	],
	resolve: {
		extensions: ['*', '.js'],
		alias: {
			'pdfjs/pdf.worker.js': path.resolve(__dirname, 'pdf.js/src/pdf.worker.js'),
			'display-node_utils': path.resolve(__dirname, 'pdf.js/src/display/node_utils.js'),
			'display-cmap_reader_factory': path.resolve(__dirname, 'pdf.js/src/display/cmap_reader_factory.js'),
			'display-standard_fontdata_factory': path.resolve(__dirname, 'pdf.js/src/display/standard_fontdata_factory.js'),
			'display-wasm_factory': path.resolve(__dirname, 'pdf.js/src/display/wasm_factory.js'),
			'display-fetch_stream': path.resolve(__dirname, 'pdf.js/src/display/fetch_stream.js'),
			'display-network': path.resolve(__dirname, 'pdf.js/src/display/network.js'),
			'display-node_stream': path.resolve(__dirname, 'pdf.js/src/display/node_stream.js'),
		}
	}
};
