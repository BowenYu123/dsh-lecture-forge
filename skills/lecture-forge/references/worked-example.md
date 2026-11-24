# 范本：一节合格讲义的颗粒度

下面的片段展示**结构、来源标记、推导颗粒度、标注块与练习**。不是完整讲义，只对齐风格。

---

# 变分法入门：从泛函到 Euler–Lagrange 方程

> 本讲义面向学过微积分与常微分方程的本科二年级学生。目标：能独立写出泛函的一阶变分、推导 Euler–Lagrange 方程，并判断边界条件何时给出自然边界条件。

## 2. Euler–Lagrange 方程的推导 {#sec-euler-lagrange}

本节要解决的问题：给定泛函

$$
S[y]=\int_a^b L(x,y(x),y'(x))\,dx,
$$

在端点固定的条件 $y(a)=y_a,\ y(b)=y_b$ 下，什么样的曲线 $y$ 使 $S$ 取极值？原文直接给出结论“令 $\delta S=0$ 即得 (2.1)”，省略了边界项的处理；下面补全每一步 [S01, p.12]。

**第一步：构造单参数族。** 取任意满足 $\eta(a)=\eta(b)=0$ 的光滑函数 $\eta$，令

$$
y_\epsilon(x)=y(x)+\epsilon\,\eta(x).
$$

端点固定保证 $y_\epsilon(a)=y_a,\ y_\epsilon(b)=y_b$，即所有比较曲线都在同一族里。

**第二步：把 $S$ 看成 $\epsilon$ 的函数。**

$$
S(\epsilon)=\int_a^b L\bigl(x,\ y+\epsilon\eta,\ y'+\epsilon\eta'\bigr)\,dx .
$$

**第三步：在 $\epsilon=0$ 处求导（这就是一阶变分）。** 由链式法则与积分号下求导（$L$ 关于 $y,y'$ 连续可微即可交换），

$$
\delta S:=\left.\frac{dS}{d\epsilon}\right|_{\epsilon=0}
=\int_a^b\left(\frac{\partial L}{\partial y}\,\eta+\frac{\partial L}{\partial y'}\,\eta'\right)dx .
$$

**第四步：分部积分，把 $\eta'$ 换成 $\eta$。** 对第二项用分部积分：

$$
\int_a^b \frac{\partial L}{\partial y'}\,\eta'\,dx
=\left[\frac{\partial L}{\partial y'}\,\eta\right]_a^b
-\int_a^b \frac{d}{dx}\!\left(\frac{\partial L}{\partial y'}\right)\eta\,dx .
$$

**第五步：边界项消失。** 因为 $\eta(a)=\eta(b)=0$，中括号一项为零。于是

$$
\delta S=\int_a^b\left(\frac{\partial L}{\partial y}-\frac{d}{dx}\frac{\partial L}{\partial y'}\right)\eta\,dx .
$$

**第六步：用变分法基本引理。** 若上式对**所有**满足端点为零的光滑 $\eta$ 都成立，则括号内恒为零：

$$
\boxed{\ \frac{\partial L}{\partial y}-\frac{d}{dx}\frac{\partial L}{\partial y'}=0\ }
\tag{2.1}
$$

> [!CLARIFY] 原文说“边界项自然消失”，这只在**固定端点**时成立。若端点是自由的（例如只固定 $y(a)$，$y(b)$ 可动），则 $\eta(b)\neq0$，边界项给出**自然边界条件**
> $$
> \left.\frac{\partial L}{\partial y'}\right|_{x=b}=0 .
> $$
> 判断端点是否自由，是变分问题容易出错的第一步 [S01, p.12]。

> [!WARN] 原文式 (2.3) 把 $\dfrac{d}{dx}$ 写成 $\dfrac{\partial}{\partial x}$。沿曲线求的是**全导数**
> $$
> \frac{d}{dx}=\frac{\partial}{\partial x}+y'\,\frac{\partial}{\partial y}+y''\,\frac{\partial}{\partial y'},
> $$
> 当 $L$ 不显含 $x$ 时第一项为零。记号混用会导致后面能量积分推错 [S01, p.13]。

> [!DERIVE] 补充：$L$ 不显含 $x$ 时的首次积分
> 把 (2.1) 乘以 $y'$ 并利用 $\dfrac{dL}{dx}=\dfrac{\partial L}{\partial y}y'+\dfrac{\partial L}{\partial y'}y''$，可得
> $$
> \frac{d}{dx}\left(y'\frac{\partial L}{\partial y'}-L\right)=0
> \quad\Longrightarrow\quad
> y'\frac{\partial L}{\partial y'}-L=\text{const}.
> $$
> 这就是 Beltrami 恒等式；它与能量守恒是同一件事。

### 例 2.1（最速降线） {#ex-brachistochrone}

求连接 $(0,0)$ 与 $(x_1,y_1)$ 的曲线，使质点在重力下无摩擦滑行时间最短。取 $y$ 向下为正，速度为 $\sqrt{2gy}$，故

$$
T[y]=\int_0^{x_1}\sqrt{\frac{1+y'^2}{2gy}}\,dx,\qquad
L(y,y')=\sqrt{\frac{1+y'^2}{2gy}} .
$$

$L$ 不显含 $x$，用 Beltrami 恒等式：

$$
y'\frac{\partial L}{\partial y'}-L
=\frac{-1}{\sqrt{2gy(1+y'^2)}}=\text{const}
\ \Longrightarrow\ y(1+y'^2)=2c .
$$

令 $y=c(1-\cos\theta)$，代入化简得 $x=c(\theta-\sin\theta)$——摆线。这正是约翰·伯努利 1696 年给出的解。

### 练习 2.2 {#ex-2-2}

**基础** 写出泛函 $S[y]=\int_0^1 (y'^2+y^2)\,dx$ 的 Euler–Lagrange 方程，并求通解。

**进阶** 若把端点改为 $y(0)=0$、$y(1)$ 自由，写出自然边界条件，并求满足它的解。

**挑战** 对 $L=\frac12 m y'^2-V(y)$，证明 Beltrami 恒等式等价于机械能守恒。

> **解答（节选）**
> 基础：$L=y'^2+y^2$，$\partial L/\partial y=2y$，$\partial L/\partial y'=2y'$，故 $2y-2y''=0$，即 $y''=y$，通解 $y=C_1e^x+C_2e^{-x}$。
> 进阶：自然边界条件为 $y'(1)=0$；结合 $y(0)=0$ 得 $y=C\sinh x$，再由 $y'(1)=C\cosh1=0$ 得 $C=0$（只有零解）——这说明“自由端点 + 给定泛函”未必有非平凡极值，是常见误区。

---

## 检查点

- 本章有 3 个 `[!CLARIFY]` / `[!WARN]` / `[!DERIVE]` 标注，每个都指回原素材页码；
- 推导从“令 $\delta S=0$”展开到六个可检验的步骤，没有跳步；
- 例题给了完整建模与化简，练习分三档并附关键解答；
- 图（此处省略）应为摆线曲线，由 `lecture_figure plot` 生成并标注 $x(\theta),y(\theta)$。

> 写作提示：不要为了显得“完整”而堆砌公式；每一步都要能回答“为什么可以这样做”（交换积分与求导的条件、边界项为何为零、引理为何适用）。
