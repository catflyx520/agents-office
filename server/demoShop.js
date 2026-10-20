// Authored fiction for the automatic Demo. No AI requests, project writes or real shop APIs.
const itemExample = JSON.stringify({ itemId: 'item_demo_01', productId: 'product_tshirt', skuId: 'sku_tshirt_black_m',
  name: 'Cotton T-Shirt', color: 'Black', size: 'M', quantity: 2, unitPrice: 2900, lineTotal: 5800, availableStock: 6 }, null, 2);
const orderExample = JSON.stringify({ cartId: 'cart_demo_01', expectedTotal: 6300,
  shippingAddress: { recipient: 'Demo Buyer', addressLine1: '123 Example Street', city: 'Example City', postalCode: '00000', countryCode: 'US' } }, null, 2);
const code = value => '\n```json\n' + value + '\n```\n';

const zh = {
  sample: '【Demo 示例 · 预设剧情 · 不调用 AI】',
  userLabel: '示例用户（自动播放台词）',
  confirmationReply: '确认以上需求、API 和任务，按这个版本开始执行。',
  initialRequest: '我想做一个卖衣服的商城，电脑和手机都能用，可以看商品、加购物车、下单。',
  intro: `**商城方案 v1：先讨论，再派发任务**

我先整理第一版范围：商品列表、商品详情、购物车、结算表单和订单确认。Web 和 Mobile 共用后端接口。

详情页先考虑“加入购物车”和“立即购买”两个入口，但现在还不分配开发任务。

需要先和你确认：用户必须登录才能买吗？这次要接真实支付吗？衣服有没有颜色和尺码？

接下来会自动播放示例用户与 PM 的多轮讨论、方案修改和最终确认。全部台词都是预设剧情，观看时无需回复或操作。剧情中的用户确认前，Backend、Frontend、Mobile 保持待命。`,
  rounds: [
    {
      reply: '先不要登录，也不用真的付款，能创建订单就行。衣服有颜色和尺码。',
      pm: `**方案 v1 → v2：游客购买与商品规格**

收到。我把购买流程调整为游客下单，订单创建后显示订单编号和明细，本阶段不接支付。

衣服按 SKU 管理：每个颜色、尺码组合分别记录价格和库存。加入购物车提交 skuId，不只提交商品 ID。

| 修改项 | 原方案 | 修改后 |
| --- | --- | --- |
| 账号 | 是否登录待确认 | 游客购买 |
| 支付 | 是否对接待确认 | 创建订单，不接支付 |
| 商品 | 普通商品 | 颜色、尺码和 SKU |
| 库存 | 商品层面 | 每个 SKU 独立库存 |

详情页的“加入购物车”和“立即购买”是否都保留？另外，规格未选完整时应该怎样处理？`,
    },
    {
      reply: '不要立即购买，先都放购物车。没选颜色和尺码不能加入，购物车里面可以改数量，也可以删掉商品。',
      pm: `**方案 v2 → v3：统一购物车入口**

已修改：删除“立即购买”，所有购买操作统一经过购物车。颜色或尺码没有选完整时，页面提示缺少的选项，不发送加入请求；所选 SKU 缺货时禁用按钮。

同一 SKU 重复加入时合并数量；同一件衣服的不同颜色、尺码显示为不同条目。购物车支持修改数量和删除商品。

| 修改项 | 原方案 | 修改后 |
| --- | --- | --- |
| 购买入口 | 加入购物车、立即购买 | 只保留加入购物车 |
| 规格校验 | 尚未明确 | 完整选择颜色和尺码后才能提交 |
| 购物车操作 | 仅加入 | 调整数量、删除、刷新金额 |

我建议加入购物车时检查库存，但不占用库存；创建订单时再次检查。缺货时保留购物车，让用户调整后继续。运费规则你希望怎么定？`,
    },
    {
      reply: '加购物车先不占库存。下单没库存要告诉我是哪件衣服，不能清空购物车。满 100 美元免运费，不满收 5 美元，优惠券先不要做。',
      pm: `**方案 v3 → v4：库存失败与运费规则**

已加入这些规则：购物车不锁库存；创建订单时重新校验 SKU 库存。缺货返回具体 skuId 和可购买数量，Web 和 Mobile 标记对应条目，保留购物车及收货信息。

只有订单创建成功才清空本次购物车。商品小计满 $100 免运，否则运费 $5，本阶段不做优惠券。

金额由后端计算并使用整数分传输。例如两件 T 恤各 2900，小计 5800，运费 500，总额 6300，页面显示 $63.00。

| 修改项 | 原方案 | 修改后 |
| --- | --- | --- |
| 缺货 | 处理待明确 | 指出 SKU 和剩余库存，保留用户输入 |
| 运费 | 未确定 | 满 10000 免运，否则 500 |
| 清空购物车 | 时机未确定 | 订单成功后执行 |

如果下单按钮点两次，或者断网后重试，我建议按同一次请求处理，避免重复创建订单。`,
    },
    {
      reply: '对，下单点两次或者网络不好重试，都不能创建两张订单。失败以后填写的地址也要留着。',
      pm: `**方案 v4 → v5：重复提交与重试**

已写进任务验收条件：提交期间禁用按钮，同一次下单使用同一个 Idempotency-Key，重试沿用该标识。后端先检查请求是否已成功，相同标识返回同一张订单，不再次扣库存。

网络失败时保留收货表单和下单标识；库存不足、数量无效和空购物车使用明确错误码，不能只返回“操作失败”。

| 修改项 | 原方案 | 修改后 |
| --- | --- | --- |
| 重复点击 | 尚无约定 | 按钮防重复操作 + 服务端幂等处理 |
| 断网重试 | 可能重新创建 | 沿用同一个请求标识 |
| 失败输入 | 保留规则不完整 | 地址、购物车和重试标识都保留 |

功能一致，但电脑和手机的购物车布局可以分别设计。你希望结算入口放在哪里？`,
    },
    {
      reply: '电脑购物车放右边。手机用单独的购物车页面，下面固定结算按钮，能一直看到总价。',
      pm: `**方案 v5 → v6：分别安排 Web 和 Mobile 布局**

已修改：Web 使用右侧购物车抽屉，展示商品条目、小计、运费、总额和结算入口。Mobile 使用独立购物车页面，商品区域滚动，底部固定总额与结算按钮。

Mobile 额外处理触控按钮尺寸、键盘遮挡和表单滚动定位。两端仍使用同一套接口与错误码。

| 修改项 | 原方案 | 修改后 |
| --- | --- | --- |
| Web 购物车 | 布局未确定 | 右侧抽屉 |
| Mobile 购物车 | 布局未确定 | 独立页面 + 底部固定结算 |
| 表单 | 一般输入 | 失败保留；手机处理键盘遮挡 |

最后确认金额变化：如果结算期间价格变了，我建议返回最新金额，等用户再次确认，不直接按变化后的金额创建订单。其他内容确认后，我再给你完整接口与任务清单。`,
    },
    {
      reply: '对，金额变了要让我重新确认。其他按刚才讨论的做，给我看最终接口和任务清单。',
      pm: `**最终方案 v7：需求与接口待你确认**

已增加价格变化处理：提交 expectedTotal 表示用户看到的金额，后端重新计算真实金额；两者不同时返回 PRICE_CHANGED 和最新购物车，等待再次确认。后端不信任客户端提交的价格。

最终流程：游客浏览服装 → 选择颜色和尺码 → 加入购物车 → 修改数量或删除 → 填写收货信息 → 创建订单 → 展示订单编号与明细。

**三位成员共用的 API 约定**

| API | 输入 | 返回 |
| --- | --- | --- |
| GET /api/products | page、pageSize | 商品列表、起始价格、分页 |
| GET /api/products/:id | 商品 ID | 商品详情、规格、各 SKU 价格与库存 |
| POST /api/carts | 创建游客购物车 | cartId |
| GET /api/carts/:cartId | cartId | 条目、小计、运费、总额 |
| POST /api/carts/:cartId/items | skuId、quantity | 更新后的完整购物车 |
| PATCH /api/carts/:cartId/items/:itemId | quantity | 更新后的完整购物车 |
| DELETE /api/carts/:cartId/items/:itemId | 条目 ID | 更新后的完整购物车 |
| POST /api/orders | cartId、expectedTotal、shippingAddress | 订单编号、状态、商品和最终金额 |

加入购物车的请求体：${code(JSON.stringify({ skuId: 'sku_tshirt_black_m', quantity: 2 }, null, 2))}
购物车条目示例：${code(itemExample)}
购物车还返回 subtotal: 5800、shippingFee: 500、total: 6300、currency: USD。

创建订单的请求头使用 Idempotency-Key: checkout-demo-001，请求体：${code(orderExample)}
统一错误结构为 error.code、error.message、error.details。INVALID_QUANTITY / CART_EMPTY 返回 400；OUT_OF_STOCK / PRICE_CHANGED 返回 409，并携带缺货 SKU、可购买数量或最新金额。

下面的任务清单会分别交给 Backend、Frontend、Mobile。接口确定后，他们可以使用相同结构的 Mock 数据同时开工。接下来自动展示任务清单和示例用户的最终确认，再开始派发。`,
    },
  ],
  plan: '【Demo 示例 · PM 最终任务清单】商城方案 v7、API v1 和以下任务交给剧情中的用户确认，随后三位成员并行执行。',
  assignment: `**PM 派发任务：商城方案 v7 / API v1**

需求和接口已由用户确认。现在同时派发 BE-01、FE-01、MOB-01，三个任务互不等待。

Backend 负责约定的 API、金额与库存规则、订单事务和幂等处理。Frontend 负责 Web 页面、右侧购物车和接口状态。Mobile 负责移动页面、底部结算、键盘及网络重试。

Frontend 和 Mobile 先用约定结构的 Mock 数据开发，再切换同一组接口。每位成员只执行收到的任务，完成后提交自己的详细总结；三份总结齐全后，PM 再向用户汇总。

这是预设示例，接下来展示任务执行过程，不会生成真实商城文件或调用这些示例 API。`,
  tasks: [
    {
      agent: 'backend-dev', id: 'BE-01',
      task: 'BE-01：实现商品、SKU、游客购物车和创建订单 API。校验规格、数量、价格与库存；相同 SKU 合并数量；满 $100 免运否则 $5；事务扣库存、创建订单、成功后清空购物车。用 Idempotency-Key 防止重复下单，返回统一错误和价格变化详情。',
      updates: [
        '**BE-01 · 收到任务 / 商品与购物车**\n\n按确认的 API v1 整理 Product、SKU、Cart、CartItem、Order 数据。商品详情返回颜色、尺码、skuId、unitPrice、availableStock。\n\n示例 addCartItem()：读取 SKU → 检查 quantity 为正整数 → 校验库存 → 查找相同 SKU → 新增条目或合并数量 → 返回完整购物车。不同颜色或尺码保持独立条目。',
        '**BE-01 · 金额与库存规则**\n\n示例 calculateCartTotals() 使用整数分计算 lineTotal 和 subtotal。subtotal >= 10000 时 shippingFee = 0，否则为 500，total = subtotal + shippingFee。Web 与 Mobile 展示相同返回值。\n\n购物车不占库存；增加数量超过可购买库存时返回 OUT_OF_STOCK，details 包含 skuId 和 availableStock，不清空已有条目。',
        '**BE-01 · 创建订单 / 幂等处理**\n\n示例 createOrder() 先查 Idempotency-Key 是否已有成功结果，再检查空购物车、最新价格与库存。expectedTotal 不一致时返回 PRICE_CHANGED。\n\n事务内重新核对并扣减 SKU 库存、保存订单与金额快照、记录幂等结果、清空购物车。幂等键使用唯一约束，同键并发冲突时读取已创建的订单。失败回滚，保留购物车；同一请求重试返回同一订单。',
      ],
      summary: `**BE-01 · Backend 详细完成总结（示例）**

**接口交付**：商品列表、商品详情、创建/读取游客购物车、添加条目、修改数量、删除条目、创建订单，共 8 个接口。商品详情包含独立 SKU 的规格、价格和库存。

**核心方法**：addCartItem() 校验并合并同一 SKU；calculateCartTotals() 统一返回 subtotal、shippingFee、total、currency；createOrder() 处理金额复核、库存事务与重复提交。

**需求落实**：游客下单；购物车不锁库存；满 $100 免运；失败保留购物车；成功后清空；金额变化先确认；重复请求返回同一订单。

**错误约定**：INVALID_QUANTITY、CART_EMPTY、OUT_OF_STOCK、PRICE_CHANGED。缺货返回条目与库存，金额变化返回最新购物车，两端无需解析模糊错误文本。

**示例数据**：黑色 M 码 T 恤单价 2900，数量 2，小计 5800，运费 500，总额 6300。subtotal 达到 10000 时运费为 0。

**交付给 PM**：接口清单、请求/返回结构、金额和库存规则、错误码，以及正常下单、缺货、价格变化和重复提交的示例结果。本段为预设交付说明，没有运行真实接口或测试。`,
    },
    {
      agent: 'frontend-dev', id: 'FE-01',
      task: 'FE-01：按已确认 API 和 Mock 数据实现 Web 商品列表、详情与规格选择、右侧购物车抽屉、结算表单、订单确认页。移除立即购买，规格完整后才提交；处理数量/删除、加载、空状态、缺货、金额变化、重复点击及失败保留输入。',
      updates: [
        '**FE-01 · 收到任务 / 页面与 Mock 数据**\n\n按 API v1 建立商品、SKU、购物车和订单的 Mock 返回结构，同时整理 listProducts()、getProduct()、addCartItem()、updateCartItem()、createOrder() 请求方法。\n\n商品详情的颜色、尺码组合定位 skuId，更新价格与库存。已按需求删除“立即购买”；规格不完整时显示缺失项，不提交加入请求。',
        '**FE-01 · 右侧购物车 / 金额同步**\n\n示例 addCartItem() 发送 skuId 与 quantity。成功后用完整返回值更新右侧购物车抽屉、条目数量、小计、运费和总额，不在页面复制运费规则。\n\n数量调整与删除分别调用 PATCH / DELETE；请求期间禁用当前操作。无商品时显示空购物车状态。缺货时标出对应颜色、尺码和可购买数量。',
        '**FE-01 · 结算与错误状态**\n\n校验收货信息，提交 cartId、expectedTotal、shippingAddress 与本次 Idempotency-Key。提交期间禁用重复点击。\n\n网络失败保留表单和请求标识；PRICE_CHANGED 更新金额并等待用户再次确认；订单成功展示编号、条目和最终金额，再更新购物车为空。',
      ],
      summary: `**FE-01 · Frontend 详细完成总结（示例）**

**页面与组件**：商品列表、商品详情、颜色/尺码选择、右侧购物车抽屉、收货表单、订单确认，以及对应加载、空数据和错误状态。

**讨论后的修改**：移除“立即购买”，购买统一经过购物车；规格不完整时阻止请求；缺货 SKU 禁用加入按钮；相同 SKU 合并，不同规格独立展示。

**接口接入**：加入购物车提交 skuId、quantity；修改与删除后采用完整返回值；小计、运费和总额使用后端数据。创建订单提交用户看到的 expectedTotal 和收货信息。

**失败处理**：OUT_OF_STOCK 标出商品与可购买数量；PRICE_CHANGED 展示最新金额并再次确认；网络失败保留收货信息及请求标识；提交期间防止重复操作。

**示例交互**：选择黑色 M 码、加入两件 T 恤 → 抽屉显示商品 $58、运费 $5、总额 $63 → 填写收货信息 → 创建订单 → 显示订单编号与明细。

**交付给 PM**：页面清单、组件职责、API 调用与字段映射、Mock 数据，以及正常购买、空购物车、缺货、价格变化、失败重试的示例状态。本段为预设交付说明，没有修改真实 Web 项目或执行测试。`,
    },
    {
      agent: 'app-dev', id: 'MOB-01',
      task: 'MOB-01：按同一 API 实现移动端商品列表、详情与规格选择、独立购物车、结算和订单确认。底部固定总额与结算按钮；处理触控区域、数量/删除、键盘遮挡、断网、金额变化及重试沿用同一下单标识，失败保留输入。',
      updates: [
        '**MOB-01 · 收到任务 / 移动页面**\n\n使用 API v1 相同的商品、SKU 与购物车结构，搭建商品列表、详情、规格选择和独立购物车页面。颜色、尺码完整后才允许加入，缺货规格不可提交。\n\n商品区域独立滚动，底部固定显示 total 和结算按钮，不照搬 Web 的右侧抽屉。',
        '**MOB-01 · 数量操作 / 键盘布局**\n\n数量调整调用相同 PATCH 接口，请求期间锁定该行加减按钮，成功后刷新返回数量和金额。删除最后一项时切换为空购物车状态。\n\n扩大触控区域；结算页按键盘高度调整可视区域，滚动定位当前输入框，保留收货信息。',
        '**MOB-01 · 网络恢复 / 下单重试**\n\n发起订单请求时创建本次 Idempotency-Key，重试沿用该标识。断网显示可重试提示，保留地址、购物车和下单状态。\n\nOUT_OF_STOCK 标出具体规格；PRICE_CHANGED 更新最新金额并要求确认。成功后展示订单编号与金额，并更新购物车，不因重复点击重复导航。',
      ],
      summary: `**MOB-01 · Mobile 详细完成总结（示例）**

**页面交付**：商品列表、详情与规格选择、独立购物车、收货表单、订单确认；使用与 Web 一致的 API 和金额结构。

**布局落实**：购物车商品区域滚动，底部固定总额与结算按钮；调整触控区域，处理小屏换行、键盘遮挡和输入框滚动定位。

**购物车操作**：数量更新期间锁定当前条目，成功后展示后端返回值；删除后同步金额和空状态；缺货时显示颜色、尺码与可购买数量。

**网络与重复提交**：断网保留收货信息及下单标识；同一次请求重试沿用相同标识；提交期间阻止重复操作；价格变化等待再次确认。

**示例流程**：选择规格 → 加入购物车 → 底部显示 $63 总额 → 填写收货信息 → 网络失败保留输入 → 沿用请求标识重试 → 显示同一订单的确认结果。

**交付给 PM**：移动页面清单、接口映射、触控和键盘交互说明，以及缺货、断网、重试、价格变化等示例状态。本段为预设交付说明，没有运行真实移动应用或测试。`,
    },
  ],
  finalSummary: `**PM · 商城任务整体总结（示例）**

BE-01、FE-01、MOB-01 的详细总结均已提交，三个任务全部结束后才生成本次汇总。

**本次协作交付**

Backend 交付 8 个接口的示例定义、SKU 与库存规则、金额计算、订单事务、幂等与统一错误结构。Frontend 交付 Web 商品到订单的页面和右侧购物车。Mobile 交付相同购买流程、独立购物车及底部结算交互。

**逐项对应用户确认过的修改**

| 用户要求 | 示例落实结果 |
| --- | --- |
| 不登录、不接真实支付 | 游客购买，结束于创建订单和确认 |
| 衣服包含颜色与尺码 | SKU 独立管理规格、价格与库存 |
| 不要立即购买 | 两端统一经过购物车 |
| 满 $100 免运 | 后端统一计算，两端展示返回金额 |
| 缺货不能清空输入 | 标记缺货条目，保留购物车及地址 |
| 金额变化需要再次确认 | PRICE_CHANGED 返回最新金额 |
| 不能重复创建订单 | 提交防重复 + 同一请求标识 + 后端幂等 |
| 电脑和手机布局不同 | Web 右侧抽屉；Mobile 独立页和固定结算栏 |

**成员结果**：Backend 总结了接口、业务方法和错误结构；Frontend 总结了页面、接口字段映射和失败状态；Mobile 总结了页面、触控、键盘和网络重试。三份完整总结已按角色自动展示在当前示例记录中。

**示例验收路径**：选黑色 M 码 T 恤两件 → 小计 5800、运费 500、总额 6300 → 收货表单 → 创建订单。还展示缺货、价格变化、重复提交、空购物车和网络失败的预期处理。

本次范围停在订单创建与确认，支付和物流对接属于后续阶段。以上实现、接口和结果均为预设 Demo，没有创建真实商城、执行接口、运行测试或产生模型用量。`,
};

const en = {
  sample: '[Demo sample · scripted scenario · no AI calls]',
  userLabel: 'Sample user (automatic scripted dialogue)',
  confirmationReply: 'I approve these requirements, API and assignments. Start with this version.',
  initialRequest: 'I want a clothing shop for web and mobile, with product browsing, a cart and order placement.',
  intro: `**Shop proposal v1: discuss first, assign work after approval**

My initial scope is a product list, product details, a cart, checkout and order confirmation. Web and Mobile will share the backend API.

For now, the detail page has both Add to cart and Buy now. I have not assigned development tasks yet.

First, should buyers have to sign in? Do we need real payments in this phase? Do clothes have color and size options?

The sample user/PM discussion, revisions and final approval play automatically. Every line is scripted; the viewer does not need to reply or interact. Backend, Frontend and Mobile remain on standby until the sample user approves within the story.`,
  rounds: [
    {
      reply: 'No login or real payments for now. Creating an order is enough. Clothes have colors and sizes.',
      pm: `**Proposal v1 → v2: guest checkout and product variants**

Updated: buyers can order as guests. After an order is created, show its number and details. Real payment integration is outside this phase.

Each color/size combination is a SKU with its own price and stock. Add-to-cart requests will submit skuId rather than just the product ID.

| Item | Previous | Revised |
| --- | --- | --- |
| Account | Login undecided | Guest purchase |
| Payment | Integration undecided | Create an order, no payment integration |
| Product | Basic product | Colors, sizes and SKUs |
| Inventory | Product-level | Separate stock for each SKU |

Should we keep both Add to cart and Buy now? What should happen if a buyer has not selected all options?`,
    },
    {
      reply: 'Remove Buy now and use the cart for every purchase. Require color and size before adding. Let buyers change quantities and remove items.',
      pm: `**Proposal v2 → v3: one cart-based purchase flow**

Updated: remove Buy now. All purchases go through the cart. If color or size is missing, show the missing option and do not send a request. Disable Add to cart for an out-of-stock SKU.

Adding the same SKU merges quantities. Different colors or sizes stay on separate lines. The cart supports quantity updates and item removal.

| Item | Previous | Revised |
| --- | --- | --- |
| Purchase entry | Add to cart and Buy now | Add to cart only |
| Variant validation | Not specified | Both color and size required |
| Cart actions | Add only | Update, remove and refresh totals |

I suggest checking stock when adding, without reserving it, then checking again at order submission. Keep the cart on a stock failure. How should shipping work?`,
    },
    {
      reply: 'Do not reserve stock in the cart. If checkout runs out of stock, identify the item and keep the cart. Shipping is free from $100, otherwise $5. No coupons yet.',
      pm: `**Proposal v3 → v4: stock failures and shipping**

Added: the cart does not reserve inventory. Recheck each SKU when creating the order. On insufficient stock, return skuId and the available quantity; Web and Mobile mark that line and preserve the cart and address.

Clear the cart only after the order succeeds. Shipping is free for a product subtotal of at least $100, otherwise $5. Coupons are outside this phase.

The backend calculates money in integer cents. Two T-shirts at 2900 give subtotal 5800, shipping 500 and total 6300, displayed as $63.00.

| Item | Previous | Revised |
| --- | --- | --- |
| Stock failure | Unspecified | Identify the SKU and preserve input |
| Shipping | Undecided | Free from 10000, otherwise 500 |
| Clear cart | Timing undecided | Only after a successful order |

For double clicks or retries after a network failure, I suggest treating them as the same request to prevent duplicate orders.`,
    },
    {
      reply: 'Yes. Double clicks and network retries must not create two orders. Keep the address I entered if submission fails.',
      pm: `**Proposal v4 → v5: duplicate submissions and retries**

Added to acceptance criteria: disable repeat submission while pending. Use one Idempotency-Key for an order attempt and reuse it on retries. The backend first checks for an existing successful result and returns that same order without deducting stock again.

Keep the address and request key on network failure. Invalid quantity, empty cart and insufficient stock have explicit error codes rather than a generic failure message.

| Item | Previous | Revised |
| --- | --- | --- |
| Double click | No rule | UI guard plus backend idempotency |
| Network retry | Could create another order | Reuse the same request key |
| Failed input | Partially specified | Keep address, cart and retry key |

Web and Mobile share features, but their cart layouts can differ. Where would you like the checkout controls?`,
    },
    {
      reply: 'Put the web cart on the right. On mobile use a separate cart page with a fixed checkout button and a total that stays visible.',
      pm: `**Proposal v5 → v6: separate Web and Mobile layouts**

Updated: Web gets a right-hand cart drawer with items, subtotal, shipping, total and checkout. Mobile gets a dedicated cart page, independently scrolling items, and a fixed bottom total and checkout action.

Mobile also handles touch targets, keyboard overlap and scrolling the active field into view. Both clients still use the same API and error codes.

| Item | Previous | Revised |
| --- | --- | --- |
| Web cart | Layout undecided | Right-hand drawer |
| Mobile cart | Layout undecided | Dedicated page and fixed checkout bar |
| Address form | Generic inputs | Preserve on failure; handle keyboard overlap |

One last rule: if a price changes during checkout, I suggest returning the new total and asking for confirmation before creating an order. Once you agree, I will present the final API and task list.`,
    },
    {
      reply: 'Yes, ask me to confirm if the amount changes. Use everything we discussed and show me the final API and task list.',
      pm: `**Final proposal v7: requirements and API awaiting approval**

Added price-change handling: expectedTotal is the amount the buyer saw. The backend recalculates the actual total. If it differs, return PRICE_CHANGED and the latest cart, and wait for confirmation. The submitted amount is never trusted as the price to charge.

Final flow: browse clothes → select color and size → add to cart → update or remove → enter shipping details → create order → show its number and contents.

**Shared API contract**

| API | Input | Response |
| --- | --- | --- |
| GET /api/products | page, pageSize | Products, starting prices and pagination |
| GET /api/products/:id | Product ID | Details, options, SKU prices and stock |
| POST /api/carts | Create guest cart | cartId |
| GET /api/carts/:cartId | cartId | Lines, subtotal, shipping and total |
| POST /api/carts/:cartId/items | skuId, quantity | Complete updated cart |
| PATCH /api/carts/:cartId/items/:itemId | quantity | Complete updated cart |
| DELETE /api/carts/:cartId/items/:itemId | Item ID | Complete updated cart |
| POST /api/orders | cartId, expectedTotal, shippingAddress | Order number, status, items and final amount |

Add-to-cart body:${code(JSON.stringify({ skuId: 'sku_tshirt_black_m', quantity: 2 }, null, 2))}
Example cart line:${code(itemExample)}
The cart also returns subtotal: 5800, shippingFee: 500, total: 6300 and currency: USD.

Create an order with Idempotency-Key: checkout-demo-001 and this body:${code(orderExample)}
Errors use error.code, error.message and error.details. INVALID_QUANTITY / CART_EMPTY return 400; OUT_OF_STOCK / PRICE_CHANGED return 409 with the affected SKU, available quantity or latest amount.

The following assignments go to Backend, Frontend and Mobile. With a fixed contract, they can build against matching Mock data in parallel. The task list and sample user's final approval play automatically next, followed by dispatch.`,
    },
  ],
  plan: '[Demo sample · PM final assignments] The sample user reviews shop proposal v7, API v1 and these assignments before all three teammates start in parallel.',
  assignment: `**PM task dispatch: shop proposal v7 / API v1**

The user approved the requirements and API. Dispatching BE-01, FE-01 and MOB-01 together, with no dependencies between them.

Backend owns the agreed API, totals, stock, order transaction and idempotency. Frontend owns Web pages, the right-hand cart and API states. Mobile owns mobile pages, the fixed checkout bar, keyboard behavior and retries.

Frontend and Mobile start with Mock data matching the contract and later use the same API. Each teammate executes only its assigned task and submits a detailed completion report. PM summarizes only after all three reports arrive.

This is a scripted sample of execution; no real shop files or API calls are created.`,
  tasks: [
    {
      agent: 'backend-dev', id: 'BE-01',
      task: 'BE-01: Implement product, SKU, guest-cart and order APIs. Validate variants, quantities, prices and stock; merge identical SKUs; apply free shipping from $100, otherwise $5. Atomically deduct stock, create the order and clear the cart on success. Support Idempotency-Key, structured errors and price-change details.',
      updates: [
        '**BE-01 · Assignment received / products and cart**\n\nOrganizing Product, SKU, Cart, CartItem and Order around API v1. Product details expose color, size, skuId, unitPrice and availableStock.\n\nSample addCartItem(): load SKU → require a positive integer quantity → check stock → find the same SKU → insert or merge → return the complete cart. Different colors and sizes stay separate.',
        '**BE-01 · Totals and stock rules**\n\nSample calculateCartTotals() computes lineTotal and subtotal in cents. If subtotal >= 10000, shippingFee is 0; otherwise it is 500. total = subtotal + shippingFee. Web and Mobile display the same response.\n\nThe cart does not reserve stock. An excessive quantity returns OUT_OF_STOCK with skuId and availableStock and leaves existing lines intact.',
        '**BE-01 · Order transaction and idempotency**\n\nSample createOrder() checks for a successful Idempotency-Key result, then validates the cart, current prices and stock. A different expectedTotal returns PRICE_CHANGED.\n\nA transaction rechecks and deducts SKU stock, saves the order and price snapshot, records the idempotent result, and clears the cart. A unique constraint handles concurrent uses of the same key by returning the existing order. Failure rolls back and preserves the cart. A retry returns the same order.',
      ],
      summary: `**BE-01 · Backend detailed completion report (sample)**

**API deliverables:** Eight endpoints covering product list/detail, guest-cart creation/read, item add/update/delete, and order creation. Product details contain separate SKU options, prices and stock.

**Core functions:** addCartItem() validates and merges identical SKUs; calculateCartTotals() returns subtotal, shippingFee, total and currency; createOrder() handles total verification, stock transactions and repeat requests.

**Requirements implemented in the scenario:** Guest checkout; no cart stock reservation; free shipping from $100; preserve the cart on failure; clear it on success; reconfirm changed amounts; return one order for repeated requests.

**Errors:** INVALID_QUANTITY, CART_EMPTY, OUT_OF_STOCK and PRICE_CHANGED. Stock failures identify the SKU and availability; price changes return the latest cart, so clients do not parse vague messages.

**Example data:** Black/M T-shirt at 2900 × 2 gives subtotal 5800, shipping 500 and total 6300. Shipping becomes 0 at subtotal 10000.

**Handoff to PM:** Endpoint list, request/response shapes, totals and inventory rules, error codes, and sample normal, stock-failure, changed-price and duplicate-submission outcomes. This is an authored completion example; no real API or tests were run.`,
    },
    {
      agent: 'frontend-dev', id: 'FE-01',
      task: 'FE-01: Build Web product list/detail and variant selection, right-hand cart drawer, checkout and order confirmation against the agreed API and Mock data. Remove Buy now, require complete options, and handle quantity/removal, loading, empty states, stock failures, price changes, repeat clicks and preserved input on failure.',
      updates: [
        '**FE-01 · Assignment received / pages and Mock data**\n\nPreparing product, SKU, cart and order fixtures matching API v1, with listProducts(), getProduct(), addCartItem(), updateCartItem() and createOrder() request methods.\n\nColor and size resolve to skuId and update price and stock. Buy now is removed. Incomplete options show the missing fields and prevent requests.',
        '**FE-01 · Right-hand cart and totals**\n\nSample addCartItem() sends skuId and quantity. Its full response refreshes the drawer, item count, subtotal, shipping and total without duplicating shipping rules in the page.\n\nPATCH and DELETE update quantities and removal. Pending operations disable their controls. An empty cart has its own state; stock failures identify the color, size and available quantity.',
        '**FE-01 · Checkout and failures**\n\nValidating the address and submitting cartId, expectedTotal, shippingAddress and the attempt’s Idempotency-Key. Repeated clicks are disabled while pending.\n\nNetwork failure preserves the form and key. PRICE_CHANGED shows the latest total for another confirmation. Success displays the order number, items and final amount and refreshes the empty cart.',
      ],
      summary: `**FE-01 · Frontend detailed completion report (sample)**

**Pages and components:** Product list/detail, color/size selection, right-hand cart drawer, address form and order confirmation, including loading, empty and error states.

**Changes from the discussion:** Removed Buy now; all purchases use the cart. Missing options prevent requests; unavailable SKUs disable Add to cart. Identical SKUs merge; different options remain separate lines.

**API integration:** Add submits skuId and quantity. Updates and deletion use the complete response. Prices and shipping come from the backend. Order submission includes the displayed expectedTotal and address.

**Failure behavior:** OUT_OF_STOCK highlights the affected item and available quantity. PRICE_CHANGED asks the buyer to confirm the latest total. Network failures retain the address and request key. Pending submissions prevent repeat operations.

**Example interaction:** Select Black/M → add two T-shirts → drawer shows $58 items + $5 shipping = $63 → enter address → create order → show order number and contents.

**Handoff to PM:** Page list, component responsibilities, API/field mappings, Mock data, and sample normal, empty-cart, stock-failure, price-change and retry states. This is an authored completion example; no real Web project was changed or tested.`,
    },
    {
      agent: 'app-dev', id: 'MOB-01',
      task: 'MOB-01: Use the shared API for mobile product list/detail, variant selection, dedicated cart, checkout and order confirmation. Fix total and checkout at the bottom. Handle touch targets, quantity/removal, keyboard overlap, network failure, price changes and reuse of the same order-attempt key on retry; preserve failed input.',
      updates: [
        '**MOB-01 · Assignment received / mobile pages**\n\nUsing API v1 product, SKU and cart shapes for list, details, variant selection and a dedicated cart. Require complete color/size options and block unavailable SKUs.\n\nItems scroll independently above a fixed total and checkout bar, rather than copying the Web drawer.',
        '**MOB-01 · Quantity controls and keyboard**\n\nQuantity changes use the same PATCH API. Lock that line’s controls while pending and refresh quantities and amounts from the response. Removing the last item switches to the empty-cart state.\n\nEnlarging touch targets, adjusting checkout for keyboard height and scrolling the active input into view while retaining address values.',
        '**MOB-01 · Network recovery and order retry**\n\nCreate an Idempotency-Key for the order attempt and reuse it on retries. On a lost connection, show Retry and preserve the address, cart and attempt state.\n\nOUT_OF_STOCK marks the variant; PRICE_CHANGED requires confirmation of the new amount. Success shows the order number and total, updates the cart and prevents duplicate navigation.',
      ],
      summary: `**MOB-01 · Mobile detailed completion report (sample)**

**Pages:** Product list/detail and options, dedicated cart, address form and order confirmation, using the same API and money structure as Web.

**Layout requirements:** Independently scrolling cart items and a fixed bottom total/checkout bar. Larger touch targets, small-screen wrapping, keyboard avoidance and active-field scrolling.

**Cart behavior:** Lock only the affected line during a quantity update and display backend values on success. Removal refreshes totals and empty state. Stock failures show color, size and availability.

**Network and duplicate submissions:** Keep address and attempt key offline; retry the same request with the same key; block repeat actions while pending; request another confirmation for price changes.

**Example flow:** Select options → add to cart → fixed bar shows $63 → enter address → preserve inputs after network failure → retry with the same key → show confirmation of the same order.

**Handoff to PM:** Screen list, API mappings, touch/keyboard behavior and sample stock-failure, offline, retry and changed-price states. This is an authored completion example; no real mobile app or tests were run.`,
    },
  ],
  finalSummary: `**PM · Final shop delivery summary (sample)**

The detailed BE-01, FE-01 and MOB-01 reports have all arrived. This summary is produced only after every task has finished.

**Combined deliverables**

Backend supplied eight sample endpoint definitions, SKU/stock rules, totals, order transactions, idempotency and errors. Frontend supplied the Web purchase flow and right-hand cart. Mobile supplied the corresponding mobile flow, dedicated cart and fixed checkout bar.

**Mapping back to the user’s confirmed changes**

| User requirement | Scenario outcome |
| --- | --- |
| No login or real payment | Guest purchase ends at order creation/confirmation |
| Clothes have color and size | SKU-specific options, price and stock |
| Remove Buy now | Both clients purchase through the cart |
| Free shipping from $100 | Backend calculation, shared response values |
| Preserve input on stock failure | Mark affected lines; keep cart and address |
| Confirm changed amounts | PRICE_CHANGED returns the latest total |
| No duplicate orders | Pending-action guards, request key and backend idempotency |
| Different desktop/mobile layouts | Web drawer; mobile page and fixed checkout bar |

**Individual reports:** Backend documented endpoints, business functions and errors; Frontend documented pages, fields and failure states; Mobile documented screens, touch/keyboard behavior and retries. All three full reports have appeared automatically in this scenario transcript, labeled by teammate.

**Sample acceptance path:** Select two Black/M T-shirts → subtotal 5800 + shipping 500 = total 6300 → address → create order. The scenario also covers stock failures, changed prices, duplicate submissions, empty carts and network failures.

This phase ends at order creation and confirmation. Payment and shipping-provider integrations are future work. All implementation and outcomes here are authored Demo content: no real shop was created, no API or tests were executed, and no model tokens were consumed.`,
};

module.exports = { getShopDemo: language => language === 'zh' ? zh : en };
