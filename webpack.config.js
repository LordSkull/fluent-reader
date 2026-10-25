const path = require("path")
const { ProvidePlugin } = require("webpack")
const HtmlWebpackPlugin = require("html-webpack-plugin")
const { GriffelPlugin } = require("@griffel/webpack-plugin")
const MiniCssExtractPlugin = require("mini-css-extract-plugin")

module.exports = [
    {
        mode: "production",
        stats: "minimal",
        entry: "./src/bootstrap.ts",
        target: "electron-main",
        externals: {
            "better-sqlite3": "commonjs better-sqlite3",
        },
        module: {
            rules: [
                {
                    test: /\.ts$/,
                    include: /src/,
                    resolve: {
                        extensions: [".ts", ".js"],
                    },
                    use: [{ loader: "ts-loader" }],
                },
            ],
        },
        output: {
            devtoolModuleFilenameTemplate: "[absolute-resource-path]",
            path: __dirname + "/dist",
            filename: "electron.js",
        },
        node: {
            __dirname: false,
        },
    },
    {
        mode: "production",
        stats: "minimal",
        entry: "./src/preload.ts",
        target: "electron-preload",
        module: {
            rules: [
                {
                    test: /\.ts$/,
                    include: /src/,
                    resolve: {
                        extensions: [".ts", ".js"],
                    },
                    use: [{ loader: "ts-loader" }],
                },
            ],
        },
        output: {
            path: __dirname + "/dist",
            filename: "preload.js",
        },
    },
    {
        mode: "production",
        stats: "minimal",
        entry: "./src/index.tsx",
        target: "web",
        devtool: "source-map",
        performance: {
            hints: false,
        },
        resolve: {
            alias: {
                // Unmodified upstream bundle; see vendor/lovefield/README.md.
                lovefield$: path.resolve(
                    __dirname,
                    "vendor/lovefield/lovefield.min.js"
                ),
            },
            // Only the Node builtins required by rss-parser, sax and xml2js.
            // Any other builtin (e.g. crypto) must fail the build.
            fallback: {
                http: require.resolve("stream-http"),
                https: require.resolve("https-browserify"),
                stream: require.resolve("stream-browserify"),
                timers: require.resolve("timers-browserify"),
            },
        },
        module: {
            rules: [
                {
                    test: /\.(js|ts|tsx)$/,
                    include: [/src/, /node_modules\/@fluentui/],
                    use: {
                        loader: "@griffel/webpack-plugin/loader",
                    },
                },
                {
                    test: /\.ts(x?)$/,
                    include: /src/,
                    resolve: {
                        extensions: [".ts", ".tsx", ".js"],
                    },
                    use: {
                        loader: "ts-loader",
                    },
                },
                {
                    test: /\.css$/,
                    use: [MiniCssExtractPlugin.loader, "css-loader"],
                },
            ],
        },
        output: {
            path: __dirname + "/dist",
            filename: "index.js",
        },
        plugins: [
            new ProvidePlugin({
                process: "process/browser",
            }),
            new HtmlWebpackPlugin({
                template: "./src/index.html",
            }),
            new MiniCssExtractPlugin(),
            new GriffelPlugin(),
        ],
    },
]
