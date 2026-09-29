/****************************************************************************
 Copyright (c) 2017-2018 Xiamen Yaji Software Co., Ltd.

 http://www.cocos.com

 Permission is hereby granted, free of charge, to any person obtaining a copy
 of this software and associated engine source code (the "Software"), a limited,
 worldwide, royalty-free, non-assignable, revocable and non-exclusive license
 to use Cocos Creator solely to develop games on your target platforms. You
 shall not use Cocos Creator software for developing other software or tools
 that's used for developing games. You are not granted to publish, distribute,
 sublicense, and/or sell copies of Cocos Creator.

 The software or tools in this License Agreement are licensed, not sold.
 Xiamen Yaji Software Co., Ltd. reserves all rights not expressly granted to
 you.

 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 THE SOFTWARE.
 ****************************************************************************/
#include "Game.h"

// ============================================================================
// 钢琴音频内核的 JSB 绑定
//
// M0-3 时这里曾有一段「启动即播测试音」的临时钩子（`PIANO_M0_AUTOSTART`，
// 用于验证真机出声）。它调用的是一个从未存在过的 `pianoEngineForTest()`，
// 只因为宏没被定义过才一直没暴露 —— 已连同测试音一起删除（见 M0-3 的待办）。
//
// 音频流的启停现在由 TS 侧经 `jsbPiano` 控制，见 assets/scripts/audio/PianoEngine.ts；
// 平台的暂停/恢复仍留在下面的生命周期钩子里（那是平台事件，见那里的说明）。
// ============================================================================
#include "PianoBridge.h"
#include "PianoEngine.h"
#include "bindings/jswrapper/SeApi.h"

#ifndef GAME_NAME
#define GAME_NAME "CocosGame";
#endif

#ifndef SCRIPT_XXTEAKEY
#define SCRIPT_XXTEAKEY "";
#endif

Game::Game() = default;

int Game::init() {
  // 排队 JSB 注册回调。
  //
  // **必须在 BaseGame::init() 之前** —— CocosApplication 的构造函数里会
  // 调用 jsb_register_all_modules() 排队引擎自己的回调，紧接着 se->start()
  // 就把队列全部执行掉。晚于它就再也没机会注册了。
  se::ScriptEngine::getInstance()->addRegisterCallback(piano::jsb_register_piano);

  _windowInfo.title = GAME_NAME;
  // configurate window size
  // _windowInfo.height = 600;
  // _windowInfo.width  = 800;

#if CC_DEBUG
  _debuggerInfo.enabled = true;
#else
  _debuggerInfo.enabled = false;
#endif
  _debuggerInfo.port = 6086;
  _debuggerInfo.address = "0.0.0.0";
  _debuggerInfo.pauseOnStart = false;

  _xxteaKey = SCRIPT_XXTEAKEY;

  BaseGame::init();

  return 0;
}

// 音频流的暂停/恢复放在 C++ 侧而不是交给 TS —— 这是平台生命周期事件，
// 手机来电、切后台都会触发。不释放音频设备的话，音频流会被系统打断，
// 回到前台时可能起不来。
//
// 注意：这会让 TS 侧缓存的运行状态变陈旧。TS 要判断真实状态应该查
// `jsbPiano.getStatus()`，而不是自己记的布尔量。

void Game::onPause() {
  piano::sharedEngine().stop();
  BaseGame::onPause();
}

void Game::onResume() {
  piano::sharedEngine().start();
  BaseGame::onResume();
}

void Game::onClose() {
  piano::sharedEngine().destroy();
  BaseGame::onClose();
}

CC_REGISTER_APPLICATION(Game);
