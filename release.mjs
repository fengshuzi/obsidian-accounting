#!/usr/bin/env node
import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';

// 检查是否使用 --force 参数
const forceMode = process.argv.includes('--force');

// 读取 manifest.json 获取版本号
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const version = manifest.version;
const tag = `v${version}`;

console.log(`🚀 准备发布版本: ${tag}${forceMode ? ' (强制模式)' : ''}\n`);

try {
  // 1. 构建
  console.log('📦 开始构建...');
  execSync('npm run build', { stdio: 'inherit' });
  console.log('✅ 构建完成\n');

  // 2. 检查 gh cli 是否安装
  try {
    execSync('gh --version', { stdio: 'pipe' });
  } catch (error) {
    console.error('❌ 未安装 GitHub CLI (gh)');
    console.error('请先安装: brew install gh');
    console.error('然后登录: gh auth login');
    process.exit(1);
  }

  // 3. 自动检测 main.js 位置
  let mainJsPath;
  if (existsSync('dist/main.js')) {
    mainJsPath = 'dist/main.js';
  } else if (existsSync('build/main.js')) {
    mainJsPath = 'build/main.js';
  } else if (existsSync('main.js')) {
    mainJsPath = 'main.js';
  } else {
    console.error('❌ 找不到 main.js 文件');
    process.exit(1);
  }
  console.log(`📄 检测到 main.js: ${mainJsPath}\n`);

  // 4. 检测其他文件
  const files = [mainJsPath, 'manifest.json'];
  if (existsSync('styles.css')) files.push('styles.css');
  if (existsSync('config.json')) files.push('config.json');
  
  console.log(`📦 将上传文件: ${files.join(', ')}\n`);

  // 5. 创建 git tag
  console.log(`📌 创建 tag: ${tag}`);
  try {
    if (forceMode) {
      // 强制模式：删除本地和远程的旧tag
      console.log('⚠️  强制模式：删除旧 tag...');
      try {
        execSync(`git tag -d ${tag}`, { stdio: 'pipe' });
        console.log('  ✓ 删除本地 tag');
      } catch (e) {
        // 本地tag不存在，忽略
      }
      try {
        execSync(`git push origin :refs/tags/${tag}`, { stdio: 'pipe' });
        console.log('  ✓ 删除远程 tag');
      } catch (e) {
        // 远程tag不存在，忽略
      }
      try {
        execSync(`gh release delete ${tag} -y`, { stdio: 'pipe' });
        console.log('  ✓ 删除旧 release');
      } catch (e) {
        // release不存在，忽略
      }
    }
    execSync(`git tag ${tag}`, { stdio: 'pipe' });
    console.log('✅ Tag 创建成功\n');
  } catch (error) {
    if (forceMode) {
      console.error('❌ Tag 创建失败');
      process.exit(1);
    } else {
      console.log('⚠️  Tag 已存在，使用 --force 参数可强制覆盖\n');
      console.log('   npm run release -- --force\n');
      process.exit(1);
    }
  }

  // 6. 推送 tag
  console.log('⬆️  推送 tag 到 GitHub...');
  execSync(`git push origin ${tag}`, { stdio: 'inherit' });
  console.log('✅ Tag 推送成功\n');

  // 7. 创建 GitHub Release
  console.log('🎉 创建 GitHub Release...');
  const filesArg = files.join(' ');
  execSync(
    `gh release create ${tag} ${filesArg} --title "${tag}" --notes "Release ${version}"`,
    { stdio: 'inherit' }
  );
  console.log('\n✅ Release 创建成功！\n');

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🎊 版本 ${tag} 发布完成！`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
} catch (error) {
  console.error('\n❌ 发布失败:', error.message);
  process.exit(1);
}
