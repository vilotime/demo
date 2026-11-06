# Markdown 语法速查

站点使用 GFM（GitHub Flavored Markdown）渲染，下面这些写法都可以直接用。

## 标题

```markdown
# 一级标题
## 二级标题
### 三级标题
```

## 文本样式

**粗体**、*斜体*、~~删除线~~、`行内代码`、[链接](https://github.com)、以及脚注式的引用[^note]。

[^note]: 这是一个脚注示例（部分渲染器支持）。

## 列表

- 无序列表
  - 嵌套项
  - 再嵌套一层
- 第二项

1. 有序列表
2. 第二项
   1. 嵌套有序

- [x] 已完成的任务
- [ ] 未完成的任务

## 引用

> 一级引用
>
> > 嵌套引用

## 表格

| 左对齐 | 居中 | 右对齐 |
| :--- | :----: | ----: |
| 内容 | 内容 | 123 |
| 长一点的内容 | `code` | 4.56 |

## 代码块

```javascript
function greet(name) {
  // 支持语法高亮
  return `你好，${name}！`;
}
```

```python
def fib(n: int) -> int:
    return n if n < 2 else fib(n - 1) + fib(n - 2)
```

```bash
node tools/dev-server.mjs
```

## 图片

![示意图](./附件/示意图.svg)

## 分隔线

---

## 行内 HTML

<details>
<summary>点击展开</summary>

这里是被 `<details>` 折叠起来的内容，HTML 原样保留。

</details>

## 演示模式的分页标记

```markdown
<!-- slide -->    ← 显式分页（不会显示在页面上）

---               ← 独立的分隔线同样会被当作分页符

***
```

如果全文一个分页符都没有，会退化为按 `##` 二级标题分页。
