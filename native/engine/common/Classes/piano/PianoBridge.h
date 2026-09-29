/****************************************************************************
 * 钢琴音频内核 —— JSB 绑定
 *
 * 对应《横屏高仿真钢琴落地实施方案》§3.2。
 *
 * 把所有接口挂在全局对象 `jsbPiano` 上，TS 侧经 `PianoEngine.ts` 访问。
 ****************************************************************************/

#pragma once

namespace se {
class Object;
}  // namespace se

namespace piano {

/**
 * 把音频内核暴露给脚本层。
 *
 * 通过 `se::ScriptEngine::getInstance()->addRegisterCallback()` 注册，
 * 在脚本引擎初始化时被调用一次。
 *
 * @param globalThis 脚本的全局对象
 * @return 是否注册成功
 */
bool jsb_register_piano(se::Object* globalThis);

}  // namespace piano
