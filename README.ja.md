# Tauri + Vanilla TS

このテンプレートは、Tauri を vanilla HTML、CSS、TypeScript で開発を始めるためのものです。

## 推奨IDE設定

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

## 開発環境のセットアップ

### 方法1: Dev Containerを使用

1. VS Code でこのプロジェクトを開く
2. "Dev Containers" 拡張機能をインストール
3. `Cmd+Shift+P` (Mac) または `Ctrl+Shift+P` (Windows/Linux) を押す
4. "Dev Containers: Reopen in Container" を選択
5. コンテナのビルドが完了するまで待つ（初回は数分かかる場合があります）
6. 開発サーバーを起動:
   ```bash
   npm run tauri dev
   ```
7. ブラウザで `http://localhost:6080` を開く
8. パスワード `vscode` でログイン
9. 仮想デスクトップ環境内にTauriデスクトップアプリが表示されます

### 方法2: ホストマシンで実行

#### 前提条件

**macOS:**
```bash
# Xcode Command Line Toolsをインストール
xcode-select --install
```

**Linux (Debian/Ubuntu):**
```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev \
  build-essential \
  curl \
  wget \
  file \
  libxdo-dev \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev
```

**Windows:**
- [Microsoft Visual Studio C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) をインストール
- [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) をインストール

#### 依存関係のインストールと実行

```bash
# Node.js の依存関係をインストール
npm install

# 開発サーバーを起動
npm run tauri dev
```

デスクトップアプリがホストマシン上で自動的に起動します。
