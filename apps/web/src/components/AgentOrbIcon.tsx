import type { ReactNode } from 'react';

/**
 * 任务球的 agent 图标：**同心轨道 + 核心 + 卫星**。
 *
 * ## 为什么自己画，不用图标库里的现成图标
 *
 * 之前用的是通用「机器人头」图标（antd 的 RobotOutlined）。它的问题不是不好看，
 * 而是**不表达这个球的职责** —— 这个球是「任务中心」：一个 agent 在同时盯着多个任务，
 * 哪条跑完了要亮红点。机器人头像任何一个 AI 页面都能用，放在这儿没有区分度。
 *
 * 现在这版的设计对应它的真实语义：
 * - **外圈虚线轨道**：并行中的多个任务，环成一圈
 * - **中圈实线**：agent 自己在中间调度
 * - **中心实心核**：当前正在处理的那个
 * - **两颗卫星**：跑完落地的结果
 *
 * 有任务在跑时，外圈会缓慢转起来 —— 这是唯一需要「动」的状态提示：
 * 用户不必点开面板就知道「它还在干活」。
 *
 * 零新增依赖：纯 SVG，不引任何包。
 */
export function AgentOrbIcon({ size = 24, running = false }: { size?: number; running?: boolean }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block', overflow: 'visible' }}
    >
      {/* 外圈：断续轨道，代表并行中的多个任务 */}
      <circle
        className={running ? 'task-orb-ring' : undefined}
        cx="12"
        cy="12"
        r="9.1"
        stroke="currentColor"
        strokeOpacity={0.45}
        strokeWidth={1.55}
        strokeDasharray="4.4 3.2"
        strokeLinecap="round"
      />
      {/* 中圈：agent 本身 */}
      <circle cx="12" cy="12" r="5.3" stroke="currentColor" strokeOpacity={1} strokeWidth={2} />
      {/* 卫星：已经跑完的成果 */}
      <circle cx="12" cy="2.9" r="1.65" fill="currentColor" />
      <circle cx="19.55" cy="17.2" r="1.65" fill="currentColor" fillOpacity={0.88} />
      {/* 核心：正在处理的那个 */}
      <circle
        className={running ? 'task-orb-core' : undefined}
        cx="12"
        cy="12"
        r="2.6"
        fill="currentColor"
      />
    </svg>
  );
}
