// 调试日志函数 - 支持详细日志开关
let logCounter = 0;
const MAX_LOGS = 100; // 限制最大日志数量，防止浏览器崩溃

// 全局标志，用于跟踪是否是用户点击触发的自动选择
let isUserInitiated = false;

// 全局标志，用于跟踪是否已经设置过表格行数
let hasSetPageSize = false;

// 全局变量，用于保存 MutationObserver 引用，防止内存泄漏
let pageObserver = null;

// 初始化重试机制
let initRetryCount = 0;
const MAX_INIT_RETRY = 5;
const RETRY_DELAY = 500;

// URL轮询机制
let lastUrl = window.location.href;
let urlCheckInterval = null;

function startUrlMonitoring() {
  // 清除旧的轮询
  if (urlCheckInterval) {
    clearInterval(urlCheckInterval);
  }
  
  // 每500ms检查一次URL变化
  urlCheckInterval = setInterval(() => {
    const currentUrl = window.location.href;
    if (currentUrl !== lastUrl) {
      debugLog('检测到URL变化:', lastUrl, '->', currentUrl);
      lastUrl = currentUrl;
      checkUrlAndInit();
    }
  }, 500);
}

function stopUrlMonitoring() {
  if (urlCheckInterval) {
    clearInterval(urlCheckInterval);
    urlCheckInterval = null;
  }
}

function debugLog(message, data = null) {
  // 检查是否启用了详细调试日志
  const isDebugEnabled = localStorage.getItem('mes_extension_debug') === 'true';
  
  if (isDebugEnabled) {
    // 启用了详细日志，输出所有调试信息
    console.log('[MES插件调试]', message, data || '');
  } else {
    // 未启用详细日志，限制日志数量
    if (logCounter < MAX_LOGS) {
      console.log('[MES插件调试]', message, data || '');
      logCounter++;
    } else if (logCounter === MAX_LOGS) {
      // 输出最后一条日志，提示已达到最大日志数量
      console.log('[MES插件调试] 已达到最大日志数量，后续日志将被忽略。如需查看详细日志，请在控制台输入：localStorage.setItem(\'mes_extension_debug\', \'true\') 并刷新页面');
      logCounter++;
    }
    // 超过最大日志数量后，不再输出日志
  }
}

// 自动选择所有符合条件的班组
async function autoSelectTeams() {
  // 检查是否是用户点击触发的
  if (!isUserInitiated) {
    debugLog('自动定额功能只能通过用户点击按钮触发');
    return;
  }
  
  debugLog('开始执行自动定额功能');
  chrome.storage.sync.get(['jobTeamSettings'], async (result) => {
    const settings = result.jobTeamSettings || [];
    debugLog('获取到的工种-班组设置', settings);
    
    if (settings.length === 0) {
      createNotification('请先在设置中配置工种-班组对应关系', 3000);
      debugLog('未找到工种-班组对应关系');
      return;
    }
    
    let processedCount = 0;
    const promises = [];
    
    // 尝试处理表格结构
    debugLog('开始尝试表格结构处理');
    
    // 1. 首先尝试处理标准表格结构
    const tables = document.querySelectorAll('table');
    debugLog(`找到 ${tables.length} 个标准表格`);
    
    tables.forEach((table, tableIndex) => {
      debugLog(`处理第 ${tableIndex + 1} 个标准表格`);
      
      // 查找表头行
      let headers = [];
      let headerRow = null;
      
      // 首先查找表头行
      const rows = table.querySelectorAll('tr');
      let hasValidHeader = false;
      
      for (let rowIndex = 0; rowIndex < rows.length && !hasValidHeader; rowIndex++) {
        const cells = rows[rowIndex].querySelectorAll('th, td');
        let hasJobHeader = false;
        let hasTeamHeader = false;
        
        for (let i = 0; i < cells.length; i++) {
          const text = cells[i].textContent.trim();
          if (text.includes('工种')) {
            hasJobHeader = true;
          } else if (text.includes('班组')) {
            hasTeamHeader = true;
          }
        }
        
        if (hasJobHeader || hasTeamHeader) {
          headers = cells;
          headerRow = rowIndex;
          hasValidHeader = true;
          debugLog(`找到表头行，索引为 ${rowIndex}`);
        }
      }
      
      let jobColumnIndex = -1;
      let teamColumnIndex = -1;
      let hourColumnIndex = -1;
      
      // 查找工种、班组和额定工时的列索引
      for (let i = 0; i < headers.length; i++) {
        const text = headers[i].textContent.trim();
        if (text.includes('工种')) {
          jobColumnIndex = i;
          debugLog(`找到工种列，索引为 ${i}`);
        } else if (text.includes('班组')) {
          teamColumnIndex = i;
          debugLog(`找到班组列，索引为 ${i}`);
        } else if (text.includes('额定工时')) {
          hourColumnIndex = i;
          debugLog(`找到额定工时列，索引为 ${i}`);
        }
      }
      
      // 如果找到工种和班组列，处理表格行
      if (jobColumnIndex !== -1 && teamColumnIndex !== -1) {
        debugLog('开始处理标准表格行');
        
        // 处理数据行，跳过表头行
        for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
          // 跳过表头行
          if (rowIndex === headerRow) continue;
          
          const row = rows[rowIndex];
          // 查找当前行的所有单元格
          const cells = row.querySelectorAll('td');
          if (cells.length > Math.max(jobColumnIndex, teamColumnIndex)) {
            // 获取工种文本
            const jobCell = cells[jobColumnIndex];
            const jobText = jobCell.textContent.trim();
            
            // 特殊处理：如果工种文本为空，尝试查找相邻单元格或特定类名
            let actualJobText = jobText;
            if (!actualJobText) {
              // 尝试查找相邻单元格
              if (cells[jobColumnIndex + 1]) {
                actualJobText = cells[jobColumnIndex + 1].textContent.trim();
              }
              // 尝试查找特定类名
              const jobTextEl = jobCell.querySelector('.product-name, .font-medium, [class*="job"]');
              if (jobTextEl) {
                actualJobText = jobTextEl.textContent.trim();
              }
            }
            
            // 只有当工种文本非空时，才继续处理
            if (actualJobText) {
              // 获取班组选择器 - 支持自定义下拉组件
              const teamCell = cells[teamColumnIndex];
              debugLog(`行 ${rowIndex} 班组单元格内容:`, teamCell.innerHTML);
              
              let teamSelect = null;
              let isCustomSelect = false;
              
              // 1. 首先尝试查找标准select元素
              teamSelect = teamCell.querySelector('select');
              
              // 2. 如果未找到，尝试查找自定义下拉组件（基于用户提供的HTML结构）
              if (!teamSelect) {
                // 查找自定义下拉组件的ul元素
                const customSelectUl = teamCell.querySelector('ul, .vs-component, .vs-select--dropdown');
                if (customSelectUl) {
                  teamSelect = customSelectUl;
                  isCustomSelect = true;
                  debugLog(`行 ${rowIndex} 找到自定义下拉组件:`, customSelectUl);
                }
              }
              
              if (teamSelect) {
                // 查找匹配的班组
                const match = settings.find(setting => setting.job === actualJobText);
                if (match) {
                  debugLog(`行 ${rowIndex} 找到匹配的班组: ${actualJobText} -> ${match.team}`);
                  
                  if (isCustomSelect) {
                    // 处理自定义下拉组件
                    debugLog(`行 ${rowIndex} 处理自定义下拉组件`);
                    
                    // 创建一个 Promise 来处理异步操作
                    const selectPromise = new Promise((resolve) => {
                      // 查找下拉框的触发按钮（通常在单元格内）
                      const dropdownTrigger = teamCell.querySelector('.vs-select, .vs-component, [class*="select"]');
                      
                      if (dropdownTrigger) {
                        // 检查下拉框是否已经展开
                        const isExpanded = teamSelect.classList.contains('active') || 
                                          teamSelect.style.display !== 'none';
                        
                        if (!isExpanded) {
                          // 先点击下拉框展开它
                          debugLog(`行 ${rowIndex} 点击下拉框展开`);
                          dropdownTrigger.click();
                        } else {
                          debugLog(`行 ${rowIndex} 下拉框已展开，直接选择`);
                        }
                        
                        // 等待下拉框展开（延迟200ms）
                        setTimeout(() => {
                          // 查找所有li选项
                          const allOptions = teamSelect.querySelectorAll('li');
                          let foundOption = null;
                          
                          // 遍历所有选项，查找匹配的班组
                          for (let i = 0; i < allOptions.length; i++) {
                            const option = allOptions[i];
                            // 尝试从data-text属性获取文本
                            const optionText = option.dataset.text || option.textContent.trim();
                            
                            if (optionText === match.team) {
                              foundOption = option;
                              break;
                            }
                          }
                          
                          if (foundOption) {
                            debugLog(`行 ${rowIndex} 找到匹配的自定义选项:`, foundOption);
                            
                            // 点击匹配的选项
                            const optionButton = foundOption.querySelector('button, .vs-select--item, span, div');
                            if (optionButton) {
                              debugLog(`行 ${rowIndex} 点击自定义选项: ${match.team}`);
                              optionButton.click();
                              resolve(true);
                            } else {
                              // 如果没有找到子元素，直接点击li元素
                              debugLog(`行 ${rowIndex} 直接点击li元素: ${match.team}`);
                              foundOption.click();
                              resolve(true);
                            }
                          } else {
                            debugLog(`行 ${rowIndex} 未找到匹配的自定义选项: ${match.team}，可用选项:`, 
                              Array.from(allOptions).map(opt => opt.textContent.trim()));
                            resolve(false);
                          }
                        }, 200);
                      } else {
                        debugLog(`行 ${rowIndex} 未找到下拉框触发按钮`);
                        resolve(false);
                      }
                    });
                    
                    promises.push(selectPromise);
                  } else {
                    // 处理标准select元素
                    debugLog(`行 ${rowIndex} 处理标准select元素`);
                    for (let i = 0; i < teamSelect.options.length; i++) {
                      if (teamSelect.options[i].text === match.team) {
                        teamSelect.selectedIndex = i;
                        // 触发change事件
                        teamSelect.dispatchEvent(new Event('change'));
                        processedCount++;
                        break;
                      }
                    }
                  }
                } else {
                  debugLog(`行 ${rowIndex} 未找到匹配的班组: ${actualJobText}`);
                }
              } else {
                debugLog(`行 ${rowIndex} 未找到班组选择器`);
              }
            }
            
            // 自动填写额定工时列
            if (hourColumnIndex !== -1) {
              const hourCell = cells[hourColumnIndex];
              debugLog(`行 ${rowIndex} 额定工时单元格内容:`, hourCell.innerHTML);
              
              // 尝试多种方式查找额定工时输入框
              let hourInput = null;
              
              // 1. 首先尝试直接查找input和textarea元素
              hourInput = hourCell.querySelector('input, textarea');
              debugLog(`行 ${rowIndex} 直接查找输入框结果:`, hourInput);
              
              // 2. 如果未找到，尝试查找单元格内所有可能的输入元素
              if (!hourInput) {
                // 查找所有input元素，包括可能在嵌套结构中的
                const allInputs = hourCell.querySelectorAll('input');
                debugLog(`行 ${rowIndex} 查找所有input元素结果:`, allInputs);
                if (allInputs.length > 0) {
                  hourInput = allInputs[0];
                  debugLog(`行 ${rowIndex} 使用第一个input元素:`, hourInput);
                }
              }
              
              // 3. 如果未找到，尝试查找包含特定类名的元素
              if (!hourInput) {
                const possibleInputs = hourCell.querySelectorAll('.ant-input, .el-input__inner, .form-control, [class*="input"]');
                debugLog(`行 ${rowIndex} 查找特定类名输入框结果:`, possibleInputs);
                if (possibleInputs.length > 0) {
                  hourInput = possibleInputs[0];
                  debugLog(`行 ${rowIndex} 使用特定类名输入框:`, hourInput);
                }
              }
              
              // 如果找到输入框，填写默认值50
              if (hourInput) {
                debugLog(`行 ${rowIndex} 输入框当前值:`, hourInput.value);
                debugLog(`行 ${rowIndex} 输入框类型:`, hourInput.type);
                
                // 确保输入框可见且可编辑
                if (hourInput.offsetParent !== null && !hourInput.disabled && !hourInput.readOnly) {
                  // 无论当前值是什么，都填写50，确保覆盖默认值0
                  hourInput.value = '50';
                  debugLog(`行 ${rowIndex} 已设置输入框值为50`);
                  
                  // 触发多种事件，确保数据被正确保存
                  // 1. 触发input事件
                  hourInput.dispatchEvent(new Event('input', { bubbles: true }));
                  debugLog(`行 ${rowIndex} 已触发input事件`);
                  
                  // 2. 触发change事件
                  hourInput.dispatchEvent(new Event('change', { bubbles: true }));
                  debugLog(`行 ${rowIndex} 已触发change事件`);
                  
                  // 3. 触发blur事件，确保失去焦点时保存
                  hourInput.dispatchEvent(new Event('blur', { bubbles: true }));
                  debugLog(`行 ${rowIndex} 已触发blur事件`);
                  
                  // 4. 对于数字输入框，可能需要触发其他事件
                  if (hourInput.type === 'number') {
                    hourInput.dispatchEvent(new Event('input', { bubbles: true }));
                    debugLog(`行 ${rowIndex} 已再次触发input事件（数字类型）`);
                  }
                  
                  debugLog(`行 ${rowIndex} 已填写额定工时为50`);
                } else {
                  debugLog(`行 ${rowIndex} 输入框不可见或不可编辑，跳过填写`);
                }
              } else {
                // 未找到输入框，输出更详细的调试信息
                debugLog(`行 ${rowIndex} 未找到额定工时输入框，单元格完整HTML:`, hourCell.outerHTML);
                
                // 尝试查找其他可能的输入元素
                const allElements = hourCell.querySelectorAll('*');
                debugLog(`行 ${rowIndex} 单元格内所有元素数量:`, allElements.length);
                allElements.forEach((el, index) => {
                  debugLog(`行 ${rowIndex} 元素 ${index}:`, el.tagName, el.className, el.id);
                });
              }
            } else {
              debugLog(`行 ${rowIndex} 未找到额定工时列，跳过填写`);
            }
          }
        }
        
        debugLog(`标准表格处理完成，共匹配 ${processedCount} 个班组`);
      } else {
        debugLog('未在标准表格中找到工种和班组列');
      }
    });
    
    // 等待所有自定义下拉组件的选择操作完成
    if (promises.length > 0) {
      debugLog(`等待 ${promises.length} 个异步选择操作完成...`);
      const results = await Promise.all(promises);
      processedCount += results.filter(r => r).length;
      debugLog(`异步选择操作完成，成功 ${results.filter(r => r).length} 个`);
    }
    
    // 2. 跳过复杂的自定义表格处理，直接尝试简化版处理
    
    // 3. 简化版：直接查找页面上的所有班组选择器，并尝试匹配工种
    if (processedCount === 0) {
      debugLog('标准表格处理未找到匹配项，尝试简化版处理');
      
      // 查找页面上所有的班组选择器
      const teamSelects = document.querySelectorAll('select');
      debugLog(`找到 ${teamSelects.length} 个班组选择器`);
      
      // 仅处理前20个选择器，防止处理过多元素导致性能问题
      const limitedTeamSelects = Array.from(teamSelects).slice(0, 20);
      
      for (let i = 0; i < limitedTeamSelects.length; i++) {
        const teamSelect = limitedTeamSelects[i];
        
        // 查找最近的工种文本（向上查找兄弟元素和父元素）
        let jobText = '';
        let currentEl = teamSelect.parentElement;
        let level = 0;
        const maxLevel = 3;
        
        // 向上查找3级父元素
        while (level < maxLevel && currentEl && !jobText) {
          // 查找当前元素内的所有文本元素
          const textElements = currentEl.querySelectorAll('div, span, p, label');
          
          for (let j = 0; j < textElements.length && !jobText; j++) {
            const text = textElements[j].textContent.trim();
            // 检查文本是否匹配设置中的工种
            if (settings.some(setting => setting.job === text)) {
              jobText = text;
              debugLog(`找到匹配的工种文本: "${jobText}"`);
            }
          }
          
          if (!jobText) {
            currentEl = currentEl.parentElement;
            level++;
          }
        }
        
        if (jobText) {
          // 查找匹配的班组
          const match = settings.find(setting => setting.job === jobText);
          if (match) {
            debugLog(`找到匹配的班组: ${jobText} -> ${match.team}`);
            
            // 检查是否为自定义下拉组件
            let isCustomSelect = false;
            let customSelectUl = null;
            
            // 检查teamSelect是否为select元素
            if (teamSelect.tagName.toLowerCase() !== 'select') {
              // 尝试查找最近的自定义下拉组件
              customSelectUl = teamSelect.querySelector('ul');
              if (!customSelectUl) {
                // 尝试查找父元素中的自定义下拉组件
                customSelectUl = teamSelect.closest('div').querySelector('ul');
              }
              isCustomSelect = !!customSelectUl;
            }
            
            if (isCustomSelect) {
              // 处理自定义下拉组件
              debugLog(`处理自定义下拉组件`);
              
              // 查找所有li选项
              const allOptions = customSelectUl.querySelectorAll('li');
              let foundOption = null;
              
              // 遍历所有选项，查找匹配的班组
              for (let j = 0; j < allOptions.length; j++) {
                const option = allOptions[j];
                // 尝试从data-text属性获取文本
                const optionText = option.dataset.text || option.textContent.trim();
                
                if (optionText === match.team) {
                  foundOption = option;
                  break;
                }
              }
              
              if (foundOption) {
                debugLog(`找到匹配的自定义选项:`, foundOption);
                
                // 点击匹配的选项
                const optionButton = foundOption.querySelector('button, .vs-select--item');
                if (optionButton) {
                  debugLog(`点击自定义选项: ${match.team}`);
                  optionButton.click();
                  processedCount++;
                }
              } else {
                debugLog(`未找到匹配的自定义选项: ${match.team}`);
              }
            } else {
              // 处理标准select元素
              debugLog(`处理标准select元素`);
              for (let j = 0; j < teamSelect.options.length; j++) {
                if (teamSelect.options[j].text === match.team) {
                  teamSelect.selectedIndex = j;
                  // 触发change事件
                  teamSelect.dispatchEvent(new Event('change'));
                  processedCount++;
                  break;
                }
              }
            }
          }
        }
      }
    }
    
    // 显示处理结果
    debugLog(`自动定额完成，共处理 ${processedCount} 个班组`);
    if (processedCount > 0) {
      createNotification(`已自动匹配 ${processedCount} 个班组`, 3000);
    } else {
      createNotification('未找到可匹配的工种-班组关系', 3000);
    }
  });
}

// 创建悬浮按钮
function createFloatingButton() {
  // 创建按钮容器
  const buttonContainer = document.createElement('div');
  buttonContainer.id = 'mes-extension-buttons';
  buttonContainer.style.position = 'fixed';
  buttonContainer.style.right = '20px';
  buttonContainer.style.top = '50%';
  buttonContainer.style.transform = 'translateY(-50%)';
  buttonContainer.style.zIndex = '10000';
  buttonContainer.style.display = 'flex';
  buttonContainer.style.flexDirection = 'column';
  buttonContainer.style.gap = '10px';
  
  // 创建自动定额按钮
  const autoButton = document.createElement('button');
  autoButton.id = 'mes-auto-button';
  autoButton.textContent = '自动定额';
  autoButton.style.padding = '10px 20px';
  autoButton.style.backgroundColor = '#2196F3';
  autoButton.style.color = 'white';
  autoButton.style.border = 'none';
  autoButton.style.borderRadius = '5px';
  autoButton.style.cursor = 'pointer';
  autoButton.style.fontSize = '16px';
  autoButton.style.boxShadow = '0 2px 10px rgba(0,0,0,0.3)';
  autoButton.style.transition = 'all 0.3s ease';
  
  autoButton.addEventListener('click', async () => {
    isUserInitiated = true;
    await autoSelectTeams();
    isUserInitiated = false;
  });
  
  // 创建定额设置按钮
  const settingsButton = document.createElement('button');
  settingsButton.id = 'mes-settings-button';
  settingsButton.textContent = '定额设置';
  settingsButton.style.padding = '10px 20px';
  settingsButton.style.backgroundColor = '#4CAF50';
  settingsButton.style.color = 'white';
  settingsButton.style.border = 'none';
  settingsButton.style.borderRadius = '5px';
  settingsButton.style.cursor = 'pointer';
  settingsButton.style.fontSize = '16px';
  settingsButton.style.boxShadow = '0 2px 10px rgba(0,0,0,0.3)';
  settingsButton.style.transition = 'all 0.3s ease';
  
  settingsButton.addEventListener('click', toggleSettingsPanel);
  
  // 添加按钮到容器
  buttonContainer.appendChild(autoButton);
  buttonContainer.appendChild(settingsButton);
  
  // 添加容器到页面
  document.body.appendChild(buttonContainer);
}

// 创建设置面板
function createSettingsPanel() {
  const panel = document.createElement('div');
  panel.id = 'mes-extension-panel';
  panel.style.position = 'fixed';
  panel.style.right = '100px';
  panel.style.top = '50%';
  panel.style.transform = 'translateY(-50%)';
  panel.style.zIndex = '10000';
  panel.style.width = '300px';
  panel.style.backgroundColor = 'white';
  panel.style.border = '1px solid #ddd';
  panel.style.borderRadius = '8px';
  panel.style.boxShadow = '0 4px 20px rgba(0,0,0,0.2)';
  panel.style.padding = '20px';
  panel.style.display = 'none';
  
  // 标题
  const title = document.createElement('h3');
  title.textContent = '工种-班组对应设置';
  title.style.marginTop = '0';
  title.style.marginBottom = '20px';
  panel.appendChild(title);
  
  // 格式提示
  const formatHint = document.createElement('div');
  formatHint.textContent = '格式：工种-班组，每条数据注意换行';
  formatHint.style.fontWeight = 'bold';
  formatHint.style.marginBottom = '10px';
  formatHint.style.color = '#333';
  panel.appendChild(formatHint);
  
  // 设置列表（改为文本编辑框）
  const settingsList = document.createElement('textarea');
  settingsList.id = 'mes-settings-list';
  settingsList.style.width = '100%';
  settingsList.style.height = '150px';
  settingsList.style.padding = '10px';
  settingsList.style.border = '1px solid #ddd';
  settingsList.style.borderRadius = '4px';
  settingsList.style.fontFamily = 'monospace';
  settingsList.style.fontSize = '14px';
  settingsList.style.resize = 'vertical';
  settingsList.style.marginBottom = '15px';
  panel.appendChild(settingsList);
  
  // 保存按钮
  const saveBtn = document.createElement('button');
  saveBtn.textContent = '保存设置';
  saveBtn.style.width = '100%';
  saveBtn.style.padding = '8px';
  saveBtn.style.marginTop = '10px';
  saveBtn.style.backgroundColor = '#4CAF50';
  saveBtn.style.color = 'white';
  saveBtn.style.border = 'none';
  saveBtn.style.borderRadius = '4px';
  saveBtn.style.cursor = 'pointer';
  saveBtn.addEventListener('click', saveSettings);
  panel.appendChild(saveBtn);
  
  // 关闭按钮
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '×';
  closeBtn.style.position = 'absolute';
  closeBtn.style.top = '10px';
  closeBtn.style.right = '10px';
  closeBtn.style.width = '25px';
  closeBtn.style.height = '25px';
  closeBtn.style.lineHeight = '25px';
  closeBtn.style.textAlign = 'center';
  closeBtn.style.backgroundColor = 'transparent';
  closeBtn.style.border = 'none';
  closeBtn.style.fontSize = '20px';
  closeBtn.style.cursor = 'pointer';
  closeBtn.style.color = '#666';
  closeBtn.addEventListener('click', toggleSettingsPanel);
  panel.appendChild(closeBtn);
  
  document.body.appendChild(panel);
  
  // 加载保存的设置
  loadSettings();
}

// 切换设置面板显示状态
function toggleSettingsPanel() {
  const panel = document.getElementById('mes-extension-panel');
  if (panel) {
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  }
}

// 创建自定义通知
function createNotification(message, duration = 5000) {
  // 检查是否已存在通知，存在则移除
  const existingNotification = document.getElementById('mes-notification');
  if (existingNotification) {
    existingNotification.remove();
  }
  
  // 创建通知元素
  const notification = document.createElement('div');
  notification.id = 'mes-notification';
  notification.textContent = message;
  notification.style.position = 'fixed';
  notification.style.top = '20px';
  notification.style.right = '20px';
  notification.style.padding = '12px 24px';
  notification.style.backgroundColor = '#4CAF50';
  notification.style.color = 'white';
  notification.style.borderRadius = '4px';
  notification.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
  notification.style.fontFamily = 'Arial, sans-serif';
  notification.style.fontSize = '14px';
  notification.style.fontWeight = '500';
  notification.style.zIndex = '10001';
  notification.style.opacity = '0';
  notification.style.transition = 'opacity 0.3s ease';
  
  // 添加到页面
  document.body.appendChild(notification);
  
  // 显示通知
  setTimeout(() => {
    notification.style.opacity = '1';
  }, 100);
  
  // 倒计时关闭
  let remainingTime = duration / 1000;
  const originalMessage = message;
  
  const timer = setInterval(() => {
    remainingTime--;
    if (remainingTime <= 0) {
      clearInterval(timer);
      // 隐藏通知
      notification.style.opacity = '0';
      setTimeout(() => {
        notification.remove();
      }, 300);
    } else {
      notification.textContent = `${originalMessage} (${remainingTime}s)`;
    }
  }, 1000);
}

// 保存设置
function saveSettings() {
  const settingsText = document.getElementById('mes-settings-list').value;
  const lines = settingsText.split('\n');
  const settings = [];
  
  lines.forEach(line => {
    line = line.trim();
    if (line) {
      const parts = line.split('-');
      if (parts.length === 2) {
        const job = parts[0].trim();
        const team = parts[1].trim();
        if (job && team) {
          settings.push({ job, team });
        }
      }
    }
  });
  
  chrome.storage.sync.set({ jobTeamSettings: settings }, () => {
    // 自动折叠设置面板
    toggleSettingsPanel();
    // 显示自定义倒计时通知
    createNotification('设置已保存', 5000);
  });
}

// 加载设置
function loadSettings() {
  chrome.storage.sync.get(['jobTeamSettings'], (result) => {
    const settings = result.jobTeamSettings || [];
    const settingsList = document.getElementById('mes-settings-list');
    
    // 将设置转换为文本格式
    const settingsText = settings.map(setting => `${setting.job} - ${setting.team}`).join('\n');
    settingsList.value = settingsText;
  });
}

// 监控页面变化，只记录日志，不执行自动选择
function monitorJobChange() {
  // 简化监控函数，只记录页面变化，不执行自动选择操作
  // 自动选择操作仅在用户点击"自动定额"按钮时执行
  debugLog('页面内容已更新，等待用户点击自动定额按钮');
  
  // 移除了所有自动选择逻辑，确保只有用户点击按钮才会执行定额操作
}

// 检查URL并初始化插件
// 自动设置表格行数为50
function autoSetPageSize() {
  // 检查是否已经设置过
  if (hasSetPageSize) {
    debugLog('表格行数已设置过，跳过');
    return;
  }
  
  debugLog('开始自动设置表格行数');
  
  // 查找分页下拉框
  const pageSizeSelect = document.querySelector('select.vs-pagination--input-goto');
  
  if (pageSizeSelect) {
    debugLog('找到分页下拉框，当前值:', pageSizeSelect.value);
    
    // 检查当前值是否已经是50
    if (pageSizeSelect.value !== '50') {
      // 设置为50
      pageSizeSelect.value = '50';
      
      // 触发change事件，确保页面重新加载
      pageSizeSelect.dispatchEvent(new Event('change', { bubbles: true }));
      
      debugLog('已将表格行数设置为50');
      createNotification('已自动设置表格行数为50', 2000);
    } else {
      debugLog('表格行数已经是50，无需更改');
    }
    
    // 标记为已设置
    hasSetPageSize = true;
  } else {
    debugLog('未找到分页下拉框');
  }
}

function checkUrlAndInit() {
  // 检查当前URL是否符合条件
  const currentUrl = window.location.href;
  const targetUrlPattern = 'http://192.168.11.200:8080/hyxmes/#/hyxmes/mestask/mesProcessde/list-view/';
  
  // 更新最后URL
  lastUrl = currentUrl;
  
  // 检查是否已初始化
  const existingButtonContainer = document.getElementById('mes-extension-buttons');
  const existingPanel = document.getElementById('mes-extension-panel');
  
  if (currentUrl.includes(targetUrlPattern)) {
    debugLog('URL符合条件，开始初始化');
    // URL符合条件，确保按钮容器存在
    if (!existingButtonContainer) {
      // 确保body已存在
      if (document.body) {
        createFloatingButton();
        debugLog('悬浮窗创建成功');
        initRetryCount = 0; // 重置重试计数
      } else {
        // 如果body还未加载，进行重试
        if (initRetryCount < MAX_INIT_RETRY) {
          initRetryCount++;
          debugLog(`body未加载，${RETRY_DELAY}ms后重试 (${initRetryCount}/${MAX_INIT_RETRY})`);
          setTimeout(() => {
            checkUrlAndInit();
          }, RETRY_DELAY);
        } else {
          debugLog('重试次数已达上限，等待DOMContentLoaded事件');
          document.addEventListener('DOMContentLoaded', () => {
            if (!document.getElementById('mes-extension-buttons')) {
              createFloatingButton();
              debugLog('通过DOMContentLoaded创建悬浮窗');
            }
          }, { once: true });
        }
      }
    }
    
    // 确保设置面板存在
    if (!existingPanel) {
      if (document.body) {
        createSettingsPanel();
        debugLog('设置面板创建成功');
      }
    }
    
    // 自动设置表格行数为50
    setTimeout(() => {
      autoSetPageSize();
    }, 1000);
    
    // 监听页面动态内容变化
    // 先断开旧的 observer，防止内存泄漏
    if (pageObserver) {
      pageObserver.disconnect();
    }
    
    // 创建新的 observer
    pageObserver = new MutationObserver(() => {
      monitorJobChange();
    });
    
    pageObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  } else {
    debugLog('URL不符合条件，移除插件元素');
    // URL不符合条件，移除已存在的插件元素
    if (existingButtonContainer) {
      existingButtonContainer.remove();
    }
    if (existingPanel) {
      existingPanel.remove();
    }
    
    // 断开 observer
    if (pageObserver) {
      pageObserver.disconnect();
      pageObserver = null;
    }
    
    // 重置表格行数设置标志
    hasSetPageSize = false;
  }
}

// 初始化
function init() {
  debugLog('开始初始化插件');
  // 初始检查
  checkUrlAndInit();
  
  // 启动URL监控
  startUrlMonitoring();
  
  // 监听hash变化（SPA路由变化）
  window.addEventListener('hashchange', () => {
    debugLog('hashchange事件触发');
    checkUrlAndInit();
  });
  
  // 监听popstate事件（浏览器前进后退）
  window.addEventListener('popstate', () => {
    debugLog('popstate事件触发');
    checkUrlAndInit();
  });
  
  // 页面卸载时停止URL监控
  window.addEventListener('beforeunload', () => {
    debugLog('页面即将卸载，停止URL监控');
    stopUrlMonitoring();
  });
}

// 确保DOM加载完成后再初始化
if (document.readyState === 'loading') {
  debugLog('DOM正在加载，等待DOMContentLoaded事件');
  document.addEventListener('DOMContentLoaded', init);
} else {
  debugLog('DOM已加载完成，立即初始化');
  init();
}