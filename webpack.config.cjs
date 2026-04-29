const path = require('path');
const webpack = require('webpack');

module.exports = {
	entry: ['./src/index.js'],
	output: {
		path: path.join(__dirname, './build'),
		filename: 'worker.js',
		publicPath: '/',
		clean: {
			keep(asset) {
				return !asset.endsWith('.js');
			},
		},
		globalObject: 'this',
		library: {
			name: 'worker',
			type: 'umd',
			umdNamedDefine: true,
		},
	},
	target: 'webworker',
	node: {
		__filename: false,
		__dirname: false,
	},
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
	module: {
		parser: {
			javascript: {
				// Keep dynamic imports inside worker.js; Zotero ships a single JS worker file.
				dynamicImportMode: 'eager',
				// Keep external runtime assets as dataProvider-loaded files instead of webpack assets.
				url: false,
			},
		},
		rules: [
			{
				test: /\.m?js$/,
				resolve: {
					fullySpecified: false,
				},
			},
			{
				test: /\.ts$/,
				exclude: /node_modules/,
				use: {
					loader: 'ts-loader',
					options: {
						configFile: path.resolve(__dirname, 'tsconfig.json'),
						// Type checking is handled by `npm run typecheck`.
						transpileOnly: true,
					},
				},
			},
		],
	},
	resolve: {
		extensions: ['*', '.ts', '.js'],
		alias: {
			'pdfjs/pdf.worker.js': path.resolve(__dirname, 'pdf.js/src/pdf.worker.js'),
			'display-node_utils': path.resolve(__dirname, 'pdf.js/src/display/node_utils.js'),
			'display-binary_data_factory': path.resolve(__dirname, 'pdf.js/src/display/binary_data_factory.js'),
			'display-network_stream': path.resolve(__dirname, 'pdf.js/src/display/network_stream.js'),
			'display-cmap_reader_factory': path.resolve(__dirname, 'pdf.js/src/display/cmap_reader_factory.js'),
			'display-standard_fontdata_factory': path.resolve(__dirname, 'pdf.js/src/display/standard_fontdata_factory.js'),
			'display-wasm_factory': path.resolve(__dirname, 'pdf.js/src/display/wasm_factory.js'),
			'display-fetch_stream': path.resolve(__dirname, 'pdf.js/src/display/fetch_stream.js'),
			'display-network': path.resolve(__dirname, 'pdf.js/src/display/network.js'),
			'display-node_stream': path.resolve(__dirname, 'pdf.js/src/display/node_stream.js'),
		}
	}
};
