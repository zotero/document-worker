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
	optimization: {
		minimize: false
	},
	module: {
		rules: [
			{
				test: /\.(js)$/,
				exclude: /node_modules/,
				use: {
					loader: 'babel-loader',
					options: {
						compact: false,
						retainLines: true,
						presets: [['@babel/preset-env']],
					},
				},
			},
			{
				test: /\.onnx$/i,
				type: 'asset/inline',
				generator: {
					dataUrl: (content) => {
						const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
						return `data:application/octet-stream;base64,${buf.toString('base64')}`;
					}
				}
			},
			{
				test: /\.json$/i,
				type: 'asset/inline',
				generator: {
					dataUrl: (content) => {
						const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
						return `data:application/json;base64,${buf.toString('base64')}`;
					}
				}
			}
		],
	},
	plugins: [
		// Ignore objects that only exist on browser and break webpack building process
		new webpack.IgnorePlugin({ resourceRegExp: /^(canvas|fs|https|url|http)$/u })
	],
	resolve: {
		extensions: ['*', '.js']
	}
};
