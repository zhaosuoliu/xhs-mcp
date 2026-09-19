/**
 * @fileoverview Publishing service for BrowserClient.
 * Contains methods for publishing images and videos.
 * @module xhs/clients/services/publish
 */

import { Page } from 'patchright';
import { PublishContentParams, PublishVideoParams, PublishResult, LocationPoi } from '../../types.js';
import { sleep, resolveImagePaths, isHttpUrl } from '../../utils/index.js';
import { config } from '../../../core/config.js';
import { BrowserContextManager, log } from '../context.js';
import { TIMEOUTS, PUBLISH_SELECTORS, URLS } from '../constants.js';

/**
 * Publish service - handles content publishing
 */
export class PublishService {
  constructor(private ctx: BrowserContextManager) {}

  /**
   * Publish an image/text note.
   * Opens a visible browser window for the publishing process.
   *
   * @param params - Publishing parameters
   * @returns Publish result with success status
   */
  async publishContent(params: PublishContentParams): Promise<PublishResult> {
    log.info('Starting publishContent', { title: params.title, imageCount: params.images.length });

    if (!this.ctx.options.state) {
      log.error('Not logged in');
      return { success: false, error: 'Not logged in. Please use xhs_add_account first.' };
    }

    // 处理 HTTP URL 图片：下载到本地临时目录
    let imagePaths = params.images;
    const hasHttpUrls = params.images.some((p) => isHttpUrl(p));
    if (hasHttpUrls) {
      log.info('Detected HTTP image URLs, downloading to local...');
      try {
        imagePaths = await resolveImagePaths(params.images);
        log.info('HTTP images downloaded', { count: imagePaths.length });
      } catch (error) {
        log.error('Failed to download HTTP images', { error: error instanceof Error ? error.message : String(error) });
        return {
          success: false,
          error: `Failed to download HTTP images: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    // 使用账号的持久化上下文（稳定指纹），不再每次发布另起浏览器
    const page = await this.ctx.newPage();

    try {
      // Navigate to creator publish page (matching Go project URL)
      log.info('Navigating to creator publish page', { url: URLS.PUBLISH });
      await page.goto(URLS.PUBLISH, {
        waitUntil: 'load',
        timeout: TIMEOUTS.PAGE_LOAD,
      });

      // Wait for page to stabilize (matching Go project: WaitLoad + 2 seconds)
      log.debug('Waiting for page to stabilize...');
      await sleep(2000);

      // 等待网络空闲，超时则继续
      try {
        await page.waitForLoadState('networkidle', { timeout: TIMEOUTS.NETWORK_IDLE });
      } catch {
        log.warn('Network idle timeout, continuing...');
      }
      await sleep(1000);

      // 检查是否被重定向到登录页面
      const currentUrl = page.url();
      log.debug('Current URL after navigation', { url: currentUrl });

      if (currentUrl.includes('login') || currentUrl.includes('passport')) {
        log.error('Redirected to login page - session invalid');
        return { success: false, error: 'Session expired. Please re-login with xhs_add_account.' };
      }

      // 等待上传内容区域出现
      log.debug('Waiting for upload content area...');
      try {
        await page.waitForSelector('div.upload-content', { timeout: TIMEOUTS.UPLOAD_CONTENT });
        log.debug('Upload content area found');
      } catch (e) {
        log.error('Upload content area not found', { error: e });
        const pageTitle = await page.title();
        log.error('Page info', { title: pageTitle, url: page.url() });
        return { success: false, error: `Publish page not loaded correctly. Title: ${pageTitle}` };
      }

      // Click image upload tab (matching Go project: mustClickPublishTab)
      log.debug('Clicking upload image tab...');
      await this.clickPublishTab(page, '上传图文');
      await sleep(1000);

      // Upload images
      log.debug('Looking for upload input...');
      const uploadInput = await page.$(PUBLISH_SELECTORS.uploadInput);
      if (!uploadInput) {
        log.error('Upload input not found');
        return { success: false, error: 'Upload input not found' };
      }

      // Validate image paths
      const validPaths: string[] = [];
      for (const imgPath of imagePaths) {
        try {
          const fs = await import('fs');
          if (fs.existsSync(imgPath)) {
            validPaths.push(imgPath);
            log.debug('Valid image path', { path: imgPath });
          } else {
            log.warn('Image file not found', { path: imgPath });
          }
        } catch {
          validPaths.push(imgPath); // Let Playwright handle the error
        }
      }

      if (validPaths.length === 0) {
        log.error('No valid image paths');
        return { success: false, error: 'No valid image files found' };
      }

      // Set files
      log.info('Uploading images', { count: validPaths.length });
      await uploadInput.setInputFiles(validPaths);

      // Wait for upload complete (matching Go project: waitForUploadComplete)
      log.debug('Waiting for upload complete...');
      await this.waitForUploadComplete(page, validPaths.length);
      await sleep(2000);

      // Fill title
      log.debug('Filling title...');
      const titleInput = await page.$(PUBLISH_SELECTORS.titleInput);
      if (titleInput) {
        await titleInput.fill(params.title);
        log.info('Title set', { title: params.title });
      } else {
        log.warn('Title input not found');
      }

      // Fill content
      log.debug('Filling content...');
      // 新版发布页正文编辑器已从 quill(.ql-editor) 换成 tiptap，保留旧选择器兜底
      const contentEditor =
        (await page.$(PUBLISH_SELECTORS.contentEditor)) ||
        (await page.$('div.tiptap.ProseMirror, div[contenteditable="true"]'));
      if (contentEditor) {
        await contentEditor.click();
        await page.keyboard.type(params.content);
        log.info('Content set');
      } else {
        const contentTextbox = await page.$(PUBLISH_SELECTORS.contentTextbox);
        if (contentTextbox) {
          await contentTextbox.click();
          await page.keyboard.type(params.content);
          log.info('Content set (via textbox)');
        } else {
          log.warn('Content editor not found');
        }
      }

      await sleep(1000);

      // Add tags
      if (params.tags && params.tags.length > 0) {
        log.debug('Adding tags', { tags: params.tags });
        for (const tag of params.tags) {
          await page.keyboard.type(`#${tag}`);
          await sleep(500);

          // Wait for and click tag suggestion
          // 优先选文本正好以 #tag 开头的联想项（避免 #重庆 命中"重庆狼队"）
          const candidates = await page.$$(`${PUBLISH_SELECTORS.topicContainer}:has-text("${tag}")`);
          let clicked = false;
          for (const c of candidates) {
            const t = ((await c.textContent()) ?? '').trim();
            if (t === `#${tag}` || new RegExp(`^#?${tag}(\\s|\\d|$)`).test(t)) {
              await c.click();
              clicked = true;
              break;
            }
          }
          if (!clicked && candidates[0]) {
            await candidates[0].click();
            clicked = true;
          }
          if (!clicked) {
            await page.keyboard.press('Space');
          }
          await sleep(300);
        }
        log.info('Tags added');
      }

      // 添加地点：用户指定了地点则必须成功，失败中止发布
      if (params.location && !(await this.addLocation(page, params.location, params.locationAddress))) {
        return { success: false, error: `添加地点"${params.location}"失败，已中止发布` };
      }

      // Handle scheduled publish
      if (params.scheduleTime) {
        log.debug('Setting schedule time', { time: params.scheduleTime });
        const scheduleRadio = await page.$(PUBLISH_SELECTORS.scheduleRadio);
        if (scheduleRadio) {
          await scheduleRadio.click();
          await sleep(500);
          log.warn('Schedule time selection not fully implemented', { time: params.scheduleTime });
        }
      }

      // Click publish button
      log.info('Clicking publish button...');
      // 旧选择器可能命中"暂存离开"（同容器第一个按钮），必须优先走 shadow-root 精确解析
      const publishBtn = await this.resolveXhsPublishBtn(page);
      if (!publishBtn) {
        log.error('Publish button not found');
        return { success: false, error: 'Publish button not found' };
      }

      await publishBtn.click();
      log.info('Publish button clicked');

      // Wait for publish to complete
      await sleep(3000);

      // 等待成功页确认，不能仅凭点击就报成功
      const publishOk = await page
        .waitForFunction(
          () => location.href.includes('/publish/success') || document.body.innerText.includes('发布成功'),
          null,
          { timeout: 15000 },
        )
        .then(() => true)
        .catch(() => false);
      if (!publishOk) {
        const detail = await this.captureFailure(page, 'publish-image');
        return { success: false, error: `Publish not confirmed (no success page).${detail}` };
      }

      log.info('Publish successful');
      return { success: true };
    } catch (error) {
      log.error('Publish failed', { error: error instanceof Error ? error.message : String(error) });
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      // Keep browser open briefly for user to see result
      await sleep(2000);
      await page.close();
      log.debug('Browser page closed');
    }
  }

  /**
   * 地点联想搜索：直调创作平台官方 POI 接口（仅验登录态 cookie），与发布页下拉数据完全一致。
   * 不开页面，走持久化上下文的 request，单次 <1s。
   */
  async searchLocation(keyword: string, size = 20): Promise<LocationPoi[]> {
    if (!this.ctx.options.state) {
      throw new Error('Not logged in. Please use xhs_add_account first.');
    }
    const context = await this.ctx.ensureContext();
    const res = await context.request.post(URLS.POI_SEARCH, {
      headers: {
        'content-type': 'application/json',
        origin: 'https://creator.xiaohongshu.com',
        referer: 'https://creator.xiaohongshu.com/',
      },
      data: { latitude: 0, longitude: 0, keyword, page: 1, size, source: 'WEB', type: 3 },
    });
    if (res.status() !== 200) {
      throw new Error(`POI search HTTP ${res.status()}`);
    }
    const json = (await res.json()) as {
      code: number;
      msg?: string;
      data?: { poi_list?: Array<Record<string, unknown>> };
    };
    if (json.code !== 0) {
      throw new Error(`POI search failed: ${json.msg ?? `code ${json.code}`}`);
    }
    const list = json.data?.poi_list ?? [];
    log.info('searchLocation done', { keyword, count: list.length });
    return list.map((p) => ({
      name: String(p.name ?? ''),
      address: String(p.address ?? ''),
      fullAddress: String(p.full_address ?? ''),
      cityName: String(p.city_name ?? ''),
      poiId: String(p.poi_id ?? ''),
    }));
  }

  /**
   * 添加地点。用户指定了地点就必须成功，否则发布应中止（调用方负责判断返回值）。
   * 点击"添加地点"下拉 → 输入关键词 → 选匹配的联想项。
   * 匹配优先级：完整名称+地址 → 完整名称 → 括号前缀兜底（兼容自由输入的模糊地点）。
   */
  private async addLocation(page: Page, location: string, address?: string): Promise<boolean> {
    const key = location.split(/[（(]/)[0];
    try {
      // "添加地点"是内容设置区的下拉组件，点它的可见文本展开
      const trigger = page.getByText('添加地点', { exact: true }).first();
      if ((await trigger.count()) === 0) {
        log.warn('addLocation: trigger not found');
        await this.captureLocationDebug(page);
        return false;
      }
      await trigger.scrollIntoViewIfNeeded();
      await trigger.click();
      await sleep(1000);
      await page.keyboard.type(location);
      await sleep(2500);
      const candidates = await page.$$(`div[class*="option"]:has-text("${key}"), li:has-text("${key}"), div[class*="item"]:has-text("${key}")`);
      // 每档匹配一遍：全名+地址 → 全名 → 前缀，找到即点
      const matchers: Array<(t: string) => boolean> = [
        ...(address ? [(t: string) => t.includes(location) && t.includes(address.slice(0, 10))] : []),
        (t: string) => t.includes(location),
        (t: string) => t.includes(key),
      ];
      let clicked = false;
      outer: for (const match of matchers) {
        for (const c of candidates) {
          const t = ((await c.textContent()) ?? '').trim();
          if (t && t.length < 120 && match(t) && !t.includes('添加地点')) {
            await c.click({ timeout: 5000 }).catch(() => {});
            clicked = true;
            break outer;
          }
        }
      }
      if (!clicked) {
        // 兜底：下拉里用键盘选第一项
        await page.keyboard.press('ArrowDown');
        await sleep(300);
        await page.keyboard.press('Enter');
      }
      await sleep(1200);
      // 最终校验：选中后组件会把地点名渲染成页面文本（输入框的值不算 innerText）
      const ok = await page.evaluate((k) => document.body.innerText.includes(k), key);
      if (ok) {
        log.info('addLocation: confirmed', { location });
        return true;
      }
      log.warn('addLocation: not confirmed after selection', { location });
      await this.captureLocationDebug(page);
      return false;
    } catch (e) {
      log.warn('addLocation failed', { error: e instanceof Error ? e.message : String(e) });
      await this.captureLocationDebug(page);
      return false;
    }
  }

  /** 地点选择失败时截图到 debug 目录，便于排查联想面板结构 */
  private async captureLocationDebug(page: Page): Promise<void> {
    try {
      const fs = await import('fs');
      const path = await import('path');
      const dir = path.join(config.data.dir, 'debug');
      fs.mkdirSync(dir, { recursive: true });
      await page.screenshot({ path: path.join(dir, `location-${Date.now()}.png`) });
    } catch {
      // 截图失败忽略
    }
  }

  /**
   * 发布确认失败时采集现场：URL、页面文本片段、UA，并截图到数据目录 debug/，
   * 让失败原因可以直接从任务结果里读到。
   */
  private async captureFailure(page: Page, kind: string): Promise<string> {
    let detail = '';
    try {
      const info = await page.evaluate(() => ({
        url: location.href,
        ua: navigator.userAgent,
        text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 400),
      }));
      detail = ` url=${info.url} ua=${info.ua} text=${info.text}`;
    } catch (e) {
      detail = ` (capture failed: ${e instanceof Error ? e.message : String(e)})`;
    }
    try {
      const fs = await import('fs');
      const path = await import('path');
      const dir = path.join(config.data.dir, 'debug');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${kind}-${Date.now()}.png`);
      await page.screenshot({ path: file, fullPage: false });
      detail += ` screenshot=${file}`;
    } catch {
      // 截图失败不影响错误返回
    }
    log.error('Publish not confirmed', { kind, detail });
    return detail;
  }

  /**
   * 新版发布页底部是 closed shadow DOM 的 <xhs-publish-btn>（左"暂存离开"右"发布"），
   * 内部按钮无法用选择器命中：等待 submit-disabled 属性解除（表示上传处理完成）后，
   * 按坐标点击右侧的红色"发布"按钮。
   */
  private async resolveXhsPublishBtn(page: Page): Promise<{ click: () => Promise<void> } | null> {
    const xpb = await page.$('xhs-publish-btn');
    if (xpb) {
      // 等上传/转码完成（submit-disabled 解除）再点发布
      for (let i = 0; i < 90; i++) {
        const disabled = await xpb.getAttribute('submit-disabled');
        if (disabled !== 'true') break;
        await sleep(2000);
      }
    }
    // 底部操作栏的"暂存离开/发布"是普通 DOM 按钮（非 shadow root）：
    // 遍历页面按钮精确取文本为"发布"的那个，避免误中"暂存离开"或"发布笔记"导航
    for (const b of await page.$$('button')) {
      const t = (await b.textContent())?.trim();
      if (t === '发布') {
        log.info('Publish button resolved by exact text');
        return b;
      }
    }
    const box = xpb ? await xpb.boundingBox() : null;
    if (!box) return null;
    log.warn('Falling back to coordinate click on xhs-publish-btn');
    return { click: () => page.mouse.click(box.x + box.width * 0.58, box.y + box.height / 2) };
  }

  /**
   * Click publish tab (matching Go project: mustClickPublishTab)
   */
  private async clickPublishTab(page: Page, tabName: string): Promise<void> {
    const deadline = Date.now() + 15000;

    while (Date.now() < deadline) {
      const tabs = await page.$$('div.creator-tab');

      for (const tab of tabs) {
        const text = await tab.textContent();
        if (text?.trim() === tabName) {
          // Check if tab is blocked by overlay
          const isBlocked = await tab.evaluate((el) => {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return true;
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            const target = document.elementFromPoint(x, y);
            return !(target === el || el.contains(target));
          });

          if (isBlocked) {
            log.debug('Tab is blocked, trying to remove overlay...');
            // Try to click empty area to dismiss popover
            await page.mouse.click(400, 50);
            await sleep(200);
            continue;
          }

          await tab.click();
          log.debug('Clicked publish tab', { tabName });
          return;
        }
      }

      await sleep(200);
    }

    log.warn('Publish tab not found', { tabName });
  }

  /**
   * 等待图片上传完成
   *
   * 通过检测上传预览区域的图片数量来判断上传是否完成。
   *
   * @param page - Playwright 页面实例
   * @param expectedCount - 期望上传的图片数量
   */
  private async waitForUploadComplete(page: Page, expectedCount: number): Promise<void> {
    const checkInterval = 500;
    const startTime = Date.now();

    log.debug('Waiting for upload complete', { expectedCount });

    while (Date.now() - startTime < TIMEOUTS.IMAGE_UPLOAD) {
      // 检查已上传的图片数量
      const uploadedImages = await page.$$('.img-preview-area .pr');
      const currentCount = uploadedImages.length;

      log.debug('Upload progress', { current: currentCount, expected: expectedCount });

      if (currentCount >= expectedCount) {
        log.info('All images uploaded', { count: currentCount });
        return;
      }

      await sleep(checkInterval);
    }

    log.warn('Upload timeout, continuing anyway');
  }

  /**
   * Publish a video note.
   * Opens a visible browser window for the publishing process.
   *
   * @param params - Publishing parameters
   * @returns Publish result with success status
   */
  async publishVideo(params: PublishVideoParams): Promise<PublishResult> {
    if (!this.ctx.options.state) {
      return { success: false, error: 'Not logged in. Please use xhs_login first.' };
    }

    // 使用账号的持久化上下文（稳定指纹），不再每次发布另起浏览器
    const page = await this.ctx.newPage();

    try {
      await page.goto('https://creator.xiaohongshu.com/publish/publish', {
        waitUntil: 'domcontentloaded',
      });

      await page.waitForLoadState('networkidle').catch(() => {});
      await sleep(2000);

      // 点击"上传视频"标签（默认 Tab 已是"上传视频"时再点击会失焦，先检查激活状态）
      const activeVideoTab = await page.$('div.creator-tab.active:has-text("上传视频")');
      if (!activeVideoTab) {
        const videoTab = await page.$(PUBLISH_SELECTORS.uploadVideoTab);
        if (videoTab) {
          await videoTab.click({ timeout: 5000 }).catch(() => {});
          await sleep(1000);
        }
      }

      // 上传视频
      const uploadInput = await page.$(PUBLISH_SELECTORS.uploadInput);
      if (!uploadInput) {
        return { success: false, error: 'Upload input not found' };
      }

      await uploadInput.setInputFiles(params.videoPath);
      log.info('Uploading video', { path: params.videoPath });

      // 等待视频上传和处理（视频处理需要较长时间）
      await page.waitForSelector('.upload-success, .video-preview, .cover-container', {
        timeout: TIMEOUTS.VIDEO_UPLOAD,
      });
      await sleep(2000);

      // 上传完成后会弹出封面引导弹窗，挡住表单，需要先关闭
      const coverGuide = await page.$('button.pk-cover-guide-confirm');
      if (coverGuide) {
        await coverGuide.click().catch(() => {});
        await sleep(500);
      }

      // 如果提供了封面图，上传封面
      if (params.coverPath) {
        const coverInput = await page.$('.cover-upload input, [class*="cover"] input[type="file"]');
        if (coverInput) {
          await coverInput.setInputFiles(params.coverPath);
          await sleep(2000);
        }
      }

      // 填写标题
      const titleInput = await page.$(PUBLISH_SELECTORS.titleInput);
      if (titleInput) {
        await titleInput.fill(params.title);
      }

      // 填写内容（新版编辑器为 tiptap，保留旧选择器兜底）
      const contentEditor =
        (await page.$(PUBLISH_SELECTORS.contentEditor)) ||
        (await page.$('div.tiptap.ProseMirror, div[contenteditable="true"]'));
      if (contentEditor) {
        await contentEditor.click();
        await page.keyboard.type(params.content);
      }

      await sleep(1000);

      // 添加标签
      if (params.tags && params.tags.length > 0) {
        for (const tag of params.tags) {
          await page.keyboard.type(`#${tag}`);
          await sleep(500);
          // 优先选文本正好以 #tag 开头的联想项（避免 #重庆 命中"重庆狼队"）
          const candidates = await page.$$(`${PUBLISH_SELECTORS.topicContainer}:has-text("${tag}")`);
          let clicked = false;
          for (const c of candidates) {
            const t = ((await c.textContent()) ?? '').trim();
            if (t === `#${tag}` || new RegExp(`^#?${tag}(\\s|\\d|$)`).test(t)) {
              await c.click();
              clicked = true;
              break;
            }
          }
          if (!clicked && candidates[0]) {
            await candidates[0].click();
            clicked = true;
          }
          if (!clicked) {
            await page.keyboard.press('Space');
          }
          await sleep(300);
        }
      }

      // 添加地点：用户指定了地点则必须成功，失败中止发布
      if (params.location && !(await this.addLocation(page, params.location, params.locationAddress))) {
        return { success: false, error: `添加地点"${params.location}"失败，已中止发布` };
      }

      // 点击发布
      // 旧选择器可能命中"暂存离开"（同容器第一个按钮），必须优先走 shadow-root 精确解析
      const publishBtn = await this.resolveXhsPublishBtn(page);
      if (!publishBtn) {
        return { success: false, error: 'Publish button not found' };
      }

      await publishBtn.click();
      await sleep(3000);

      // 等待成功页确认，不能仅凭点击就报成功
      const publishOk = await page
        .waitForFunction(
          () => location.href.includes('/publish/success') || document.body.innerText.includes('发布成功'),
          null,
          { timeout: 15000 },
        )
        .then(() => true)
        .catch(() => false);
      if (!publishOk) {
        const detail = await this.captureFailure(page, 'publish-video');
        return { success: false, error: `Publish not confirmed (no success page).${detail}` };
      }

      return { success: true };
    } catch (error) {
      log.error('Video publish failed', { error: error instanceof Error ? error.message : String(error) });
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await sleep(2000);
      await page.close();
    }
  }
}
