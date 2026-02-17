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
						plugins: [['@babel/plugin-syntax-import-attributes', { deprecatedAssertSyntax: true }]],
					},
				},
			},
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
