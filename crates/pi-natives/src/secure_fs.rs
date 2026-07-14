//! Race-resistant file-jail operations for paired remote desktop sessions.
//!
//! Unix builds keep a directory fd for the root and every traversed parent.
//! Every pathname operation is then relative to one of those stable fds; no
//! realpath-then-use check is used. Windows deliberately exposes the API with
//! an explicit `UNSUPPORTED` error until an equivalent handle-relative
//! primitive exists there.
//! Atomic replacements intentionally use mode `0600`; existing modes are not
//! preserved because the temporary is a newly-created private inode.
//! The process-wide writer mutex linearizes cooperating addon calls; external
//! processes are outside that boundary and must honor revision conflicts.

use napi::bindgen_prelude::{Buffer, Error, Result};
use napi_derive::napi;

const MAX_COMPONENT_BYTES: usize = 255;
const MAX_PATH_COMPONENTS: usize = 64;
const MAX_OPERATION_BYTES: u64 = 64 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES: u64 = 100_000;
const READ_CHUNK: usize = 8 * 1024;

#[napi(object)]
pub struct SecureReadFileResult {
	pub data:            Buffer,
	pub size:            u32,
	pub revision_sha256: String,
}
#[derive(Debug)]
#[napi(object)]
pub struct SecureDirectoryEntry {
	pub name: String,
	pub path: String,
	pub kind: String,
	pub size: Option<f64>,
}

#[derive(Debug)]
#[napi(object)]
pub struct SecureListDirectoryResult {
	pub entries: Vec<SecureDirectoryEntry>,
}

#[napi(object)]
pub struct SecureWriteFileResult {
	pub size:            u32,
	pub revision_sha256: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ErrorCode {
	UnsafePath,
	NotFound,
	NotFile,
	Conflict,
	Bounds,
	Unsupported,
	Io,
}

impl ErrorCode {
	const fn as_str(self) -> &'static str {
		match self {
			Self::UnsafePath => "UNSAFE_PATH",
			Self::NotFound => "NOT_FOUND",
			Self::NotFile => "NOT_FILE",
			Self::Conflict => "CONFLICT",
			Self::Bounds => "BOUNDS",
			Self::Unsupported => "UNSUPPORTED",
			Self::Io => "IO_ERROR",
		}
	}
}

fn native_error(code: ErrorCode) -> Error {
	Error::from_reason(format!("{}: secure file operation failed", code.as_str()))
}

fn validate_limits(max_bytes: u64) -> Result<usize> {
	if max_bytes == 0 || max_bytes > MAX_OPERATION_BYTES {
		return Err(native_error(ErrorCode::Bounds));
	}
	usize::try_from(max_bytes).map_err(|_| native_error(ErrorCode::Bounds))
}

fn validate_entries(max_entries: u64) -> Result<usize> {
	if max_entries == 0 || max_entries > MAX_DIRECTORY_ENTRIES {
		return Err(native_error(ErrorCode::Bounds));
	}
	usize::try_from(max_entries).map_err(|_| native_error(ErrorCode::Bounds))
}

fn validate_revision(revision: Option<&str>) -> Result<()> {
	if let Some(value) = revision
		&& (value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()))
	{
		return Err(native_error(ErrorCode::Bounds));
	}
	Ok(())
}

#[cfg(unix)]
mod unix {
	use std::{
		ffi::{CStr, CString},
		fmt::Write as _,
		os::fd::RawFd,
		sync::{LazyLock, Mutex},
	};

	use super::*;

	struct Fd(RawFd);

	impl Fd {
		fn open_root(root: &str) -> Result<Self> {
			let root = c_string(root, ErrorCode::Io)?;
			// SAFETY: root is a valid NUL-terminated path and flags request a directory fd.
			let fd = retry_fd(|| unsafe {
				libc::open(
					root.as_ptr(),
					libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
				)
			})
			.map_err(|errno| errno_error(errno, false))?;
			Ok(Self(fd))
		}

		fn duplicate(&self) -> Result<Self> {
			// SAFETY: self.0 is an open fd owned by this guard.
			let fd =
				retry_fd(|| unsafe { libc::dup(self.0) }).map_err(|errno| errno_error(errno, false))?;
			Ok(Self(fd))
		}
	}
	impl Drop for Fd {
		fn drop(&mut self) {
			if self.0 >= 0 {
				// SAFETY: self.0 is owned by this guard and is closed at most once.
				let _ = unsafe { libc::close(self.0) };
			}
		}
	}

	struct Directory(*mut libc::DIR);

	impl Drop for Directory {
		fn drop(&mut self) {
			if !self.0.is_null() {
				// SAFETY: fdopendir returned this owned DIR pointer.
				unsafe { libc::closedir(self.0) };
			}
		}
	}

	struct TempFile<'a> {
		parent:  RawFd,
		name:    CString,
		fd:      Option<Fd>,
		renamed: bool,
		_marker: std::marker::PhantomData<&'a ()>,
	}

	impl TempFile<'_> {
		fn disarm(mut self) {
			self.renamed = true;
			self.fd.take();
		}
	}

	impl Drop for TempFile<'_> {
		fn drop(&mut self) {
			if self.renamed {
				return;
			}
			// unlinkat is safe while the temporary fd is still open and makes
			// cleanup happen on every error path.
			loop {
				// SAFETY: parent and name remain valid for the guard lifetime.
				let rc = unsafe { libc::unlinkat(self.parent, self.name.as_ptr(), 0) };
				if rc == 0 || errno() != libc::EINTR {
					break;
				}
			}
		}
	}

	#[derive(Clone, Copy, Debug, Eq, PartialEq)]
	struct Signature {
		dev:        u64,
		ino:        u64,
		size:       u64,
		mtime_sec:  i64,
		mtime_nsec: i64,
		ctime_sec:  i64,
		ctime_nsec: i64,
	}

	// One process-wide lock keeps cooperating addon writers linearizable without
	// attacker-controlled lock-map growth. External writers remain outside this
	// serialization boundary and must use the revision protocol themselves.
	static SECURE_WRITE_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

	fn errno() -> i32 {
		std::io::Error::last_os_error()
			.raw_os_error()
			.unwrap_or(libc::EIO)
	}

	fn clear_errno() {
		#[cfg(any(target_os = "linux", target_os = "android"))]
		// SAFETY: libc exposes the thread-local errno slot for this process.
		unsafe {
			*libc::__errno_location() = 0;
		}
		#[cfg(target_os = "macos")]
		unsafe {
			*libc::__error() = 0;
		}
	}

	fn retry_fd<F>(mut operation: F) -> std::result::Result<RawFd, i32>
	where
		F: FnMut() -> RawFd,
	{
		loop {
			let fd = operation();
			if fd >= 0 {
				return Ok(fd);
			}
			let error = errno();
			if error != libc::EINTR {
				return Err(error);
			}
		}
	}

	fn retry_rc<F>(mut operation: F) -> std::result::Result<(), i32>
	where
		F: FnMut() -> libc::c_int,
	{
		loop {
			if operation() == 0 {
				return Ok(());
			}
			let error = errno();
			if error != libc::EINTR {
				return Err(error);
			}
		}
	}

	fn c_string(value: &str, code: ErrorCode) -> Result<CString> {
		CString::new(value.as_bytes()).map_err(|_| native_error(code))
	}

	fn errno_error(error: i32, final_component: bool) -> Error {
		let code = match error {
			libc::ELOOP => ErrorCode::UnsafePath,
			libc::ENOENT => ErrorCode::NotFound,
			libc::ENOTDIR | libc::EISDIR => ErrorCode::NotFile,
			libc::EEXIST => ErrorCode::Conflict,
			libc::EFBIG | libc::ENOSPC => ErrorCode::Bounds,
			_ if final_component && error == libc::EPERM => ErrorCode::NotFile,
			_ => ErrorCode::Io,
		};
		native_error(code)
	}

	fn parse_path(path: &str, allow_empty: bool) -> Result<Vec<CString>> {
		if path.is_empty() {
			if allow_empty {
				return Ok(Vec::new());
			}
			return Err(native_error(ErrorCode::UnsafePath));
		}
		if path.as_bytes().contains(&0)
			|| path.starts_with('/')
			|| path.contains('\\')
			|| path.contains(':')
			|| path.len() > MAX_COMPONENT_BYTES.saturating_mul(MAX_PATH_COMPONENTS)
		{
			return Err(native_error(ErrorCode::UnsafePath));
		}
		let mut components = Vec::new();
		for component in path.split('/') {
			if component.is_empty() || component == "." || component == ".." {
				return Err(native_error(ErrorCode::UnsafePath));
			}
			if component.len() > MAX_COMPONENT_BYTES {
				return Err(native_error(ErrorCode::Bounds));
			}
			components.push(c_string(component, ErrorCode::UnsafePath)?);
			if components.len() > MAX_PATH_COMPONENTS {
				return Err(native_error(ErrorCode::Bounds));
			}
		}
		Ok(components)
	}

	fn traverse_parent(root: &Fd, components: &[CString]) -> Result<Fd> {
		let mut current = root.duplicate()?;
		for component in components {
			let stat = fstatat(current.0, component).map_err(|error| errno_error(error, false))?;
			if (stat.st_mode & libc::S_IFMT) == libc::S_IFLNK {
				return Err(native_error(ErrorCode::UnsafePath));
			}
			if !directory_mode(&stat) {
				return Err(native_error(ErrorCode::NotFile));
			}
			// SAFETY: component is NUL-terminated and current.0 is an open directory fd.
			let next = retry_fd(|| unsafe {
				libc::openat(
					current.0,
					component.as_ptr(),
					libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
				)
			})
			.map_err(|errno| errno_error(errno, false))?;
			current = Fd(next);
		}
		Ok(current)
	}

	fn fstat(fd: RawFd) -> Result<libc::stat> {
		let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
		// SAFETY: stat points to writable MaybeUninit storage and fd is an open fd.
		retry_rc(|| unsafe { libc::fstat(fd, stat.as_mut_ptr()) })
			.map_err(|errno| errno_error(errno, false))?;
		// SAFETY: fstat initialized stat after returning zero.
		Ok(unsafe { stat.assume_init() })
	}

	fn fstatat(parent: RawFd, name: &CStr) -> std::result::Result<libc::stat, i32> {
		let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
		loop {
			// SAFETY: parent is an open directory fd and name is NUL terminated.
			let rc = unsafe {
				libc::fstatat(parent, name.as_ptr(), stat.as_mut_ptr(), libc::AT_SYMLINK_NOFOLLOW)
			};
			if rc == 0 {
				// SAFETY: fstatat initialized stat after returning zero.
				return Ok(unsafe { stat.assume_init() });
			}
			let error = errno();
			if error != libc::EINTR {
				return Err(error);
			}
		}
	}

	#[allow(clippy::unnecessary_cast, reason = "libc stat field widths differ across Unix targets")]
	fn signature(stat: &libc::stat) -> Signature {
		#[cfg(any(target_os = "linux", target_os = "android"))]
		{
			Signature {
				dev:        stat.st_dev as u64,
				ino:        stat.st_ino as u64,
				size:       stat.st_size.max(0) as u64,
				mtime_sec:  stat.st_mtime,
				mtime_nsec: stat.st_mtime_nsec,
				ctime_sec:  stat.st_ctime,
				ctime_nsec: stat.st_ctime_nsec,
			}
		}
		#[cfg(target_os = "macos")]
		{
			Signature {
				dev:        stat.st_dev as u64,
				ino:        stat.st_ino as u64,
				size:       stat.st_size.max(0) as u64,
				mtime_sec:  stat.st_mtime as i64,
				mtime_nsec: stat.st_mtime_nsec as i64,
				ctime_sec:  stat.st_ctime as i64,
				ctime_nsec: stat.st_ctime_nsec as i64,
			}
		}
	}
	const fn directory_mode(stat: &libc::stat) -> bool {
		(stat.st_mode & libc::S_IFMT) == libc::S_IFDIR
	}

	const fn regular(stat: &libc::stat) -> bool {
		(stat.st_mode & libc::S_IFMT) == libc::S_IFREG
	}

	const fn mode_kind(stat: &libc::stat) -> &'static str {
		match stat.st_mode & libc::S_IFMT {
			libc::S_IFREG => "file",
			libc::S_IFDIR => "directory",
			libc::S_IFLNK => "symlink",
			_ => "other",
		}
	}

	fn read_loop(
		fd: RawFd,
		output: &mut Vec<u8>,
		cap: Option<usize>,
		hash: &mut Sha256,
	) -> Result<()> {
		let mut chunk = [0u8; READ_CHUNK];
		loop {
			let read = loop {
				// SAFETY: chunk is valid writable storage and fd is open for reading.
				let read = unsafe { libc::read(fd, chunk.as_mut_ptr().cast(), chunk.len()) };
				if read >= 0 {
					break read as usize;
				}
				if errno() != libc::EINTR {
					return Err(native_error(ErrorCode::Io));
				}
			};
			if read == 0 {
				return Ok(());
			}
			if let Some(cap) = cap
				&& output.len().saturating_add(read) > cap
			{
				return Err(native_error(ErrorCode::Bounds));
			}
			hash.update(&chunk[..read]);
			if cap.is_some() {
				output.extend_from_slice(&chunk[..read]);
			}
		}
	}

	fn read_file_fd(fd: RawFd, cap: usize) -> Result<(Vec<u8>, Signature, String)> {
		let before = fstat(fd)?;
		if !regular(&before) {
			return Err(native_error(ErrorCode::NotFile));
		}
		if signature(&before).size > cap as u64 {
			return Err(native_error(ErrorCode::Bounds));
		}
		let mut bytes = Vec::with_capacity(signature(&before).size.min(cap as u64) as usize);
		let mut hash = Sha256::new();
		read_loop(fd, &mut bytes, Some(cap), &mut hash)?;
		let after = fstat(fd)?;
		if signature(&before) != signature(&after) {
			return Err(native_error(ErrorCode::Conflict));
		}
		Ok((bytes, signature(&after), hash.finish()))
	}

	fn hash_file_fd(fd: RawFd, cap: usize) -> Result<(String, Signature)> {
		let before = fstat(fd)?;
		if !regular(&before) {
			return Err(native_error(ErrorCode::NotFile));
		}
		if signature(&before).size > cap as u64 {
			return Err(native_error(ErrorCode::Bounds));
		}
		let mut ignored = Vec::new();
		let mut hash = Sha256::new();
		read_loop(fd, &mut ignored, Some(cap), &mut hash)?;
		let after = fstat(fd)?;
		if signature(&before) != signature(&after) {
			return Err(native_error(ErrorCode::Conflict));
		}
		Ok((hash.finish(), signature(&after)))
	}

	// SAFETY: name is NUL-terminated and parent is an open directory fd.
	fn open_target(parent: RawFd, name: &CStr) -> Result<Fd> {
		let fd = retry_fd(|| {
			// SAFETY: name is NUL-terminated and parent is an open directory fd.
			unsafe {
				libc::openat(parent, name.as_ptr(), libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW)
			}
		})
		.map_err(|errno| errno_error(errno, true))?;
		let fd = Fd(fd);
		if !regular(&fstat(fd.0)?) {
			return Err(native_error(ErrorCode::NotFile));
		}
		Ok(fd)
	}

	fn random_bytes(bytes: &mut [u8]) -> Result<()> {
		#[cfg(target_os = "macos")]
		{
			// SAFETY: arc4random_buf accepts any valid writable byte slice.
			unsafe { libc::arc4random_buf(bytes.as_mut_ptr().cast(), bytes.len()) };
			return Ok(());
		}
		#[cfg(target_os = "linux")]
		{
			let mut offset = 0;
			while offset < bytes.len() {
				// SAFETY: bytes range is valid and writable.
				let count = unsafe {
					libc::syscall(
						libc::SYS_getrandom,
						bytes[offset..].as_mut_ptr().cast::<libc::c_void>(),
						bytes.len() - offset,
						0,
					)
				};
				if count >= 0 {
					offset += count as usize;
				} else if errno() != libc::EINTR {
					return Err(native_error(ErrorCode::Io));
				}
			}
			return Ok(());
		}
		#[allow(unreachable_code, reason = "cfg branches cover supported Unix targets")]
		Err(native_error(ErrorCode::Unsupported))
	}

	fn create_temp(parent: RawFd) -> Result<TempFile<'static>> {
		for _ in 0..32 {
			let mut random = [0u8; 16];
			random_bytes(&mut random)?;
			let mut name = String::from(".omp-secure-");
			for byte in random {
				let _ = write!(name, "{byte:02x}");
			}
			let name = c_string(&name, ErrorCode::Io)?;
			// SAFETY: name is NUL-terminated and parent is an open directory fd.
			let fd = retry_fd(|| {
				// SAFETY: name is NUL-terminated and parent is an open directory fd.
				unsafe {
					libc::openat(
						parent,
						name.as_ptr(),
						libc::O_WRONLY
							| libc::O_CREAT
							| libc::O_EXCL | libc::O_CLOEXEC
							| libc::O_NOFOLLOW,
						0o600,
					)
				}
			});
			let fd = match fd {
				Ok(fd) => fd,
				Err(error) if error == libc::EEXIST => continue,
				Err(error) => return Err(errno_error(error, false)),
			};
			return Ok(TempFile {
				parent,
				name,
				fd: Some(Fd(fd)),
				renamed: false,
				_marker: std::marker::PhantomData,
			});
		}
		Err(native_error(ErrorCode::Io))
	}

	fn write_all(fd: RawFd, bytes: &[u8]) -> Result<()> {
		let mut offset = 0;
		while offset < bytes.len() {
			let count = loop {
				// SAFETY: bytes range is valid for reading and fd is writable.
				let count =
					unsafe { libc::write(fd, bytes[offset..].as_ptr().cast(), bytes.len() - offset) };
				if count >= 0 {
					break count as usize;
				}
				if errno() != libc::EINTR {
					return Err(native_error(ErrorCode::Io));
				}
			};
			if count == 0 {
				return Err(native_error(ErrorCode::Io));
			}
			offset += count;
		}
		Ok(())
	}

	fn fsync(fd: RawFd) -> Result<()> {
		retry_rc(|| {
			// SAFETY: fd is an open file descriptor.
			unsafe { libc::fsync(fd) }
		})
		.map_err(|_| native_error(ErrorCode::Io))
	}

	fn install_temp(parent: RawFd, temp: &CStr, leaf: &CStr, replace: bool) -> Result<()> {
		if replace {
			return retry_rc(|| unsafe {
				// SAFETY: all fds are open directories and names are NUL-terminated.
				libc::renameat(parent, temp.as_ptr(), parent, leaf.as_ptr())
			})
			.map_err(|error| errno_error(error, true));
		}
		#[cfg(target_os = "linux")]
		{
			loop {
				// SAFETY: all fds are open directories and names are NUL-terminated.
				let rc = unsafe {
					libc::syscall(
						libc::SYS_renameat2,
						parent,
						temp.as_ptr(),
						parent,
						leaf.as_ptr(),
						1u32,
					)
				};
				if rc == 0 {
					return Ok(());
				}
				let error = errno();
				if error != libc::EINTR {
					return Err(errno_error(error, true));
				}
			}
		}
		#[cfg(target_os = "macos")]
		{
			return retry_rc(|| {
				// SAFETY: all fds are open directories and names are NUL-terminated.
				unsafe {
					libc::renameatx_np(parent, temp.as_ptr(), parent, leaf.as_ptr(), libc::RENAME_EXCL)
				}
			})
			.map_err(|error| errno_error(error, true));
		}
		#[allow(unreachable_code, reason = "Unix targets are Linux or macOS here")]
		Err(native_error(ErrorCode::Unsupported))
	}

	fn target_stat(parent: RawFd, name: &CStr) -> Result<Option<libc::stat>> {
		match fstatat(parent, name) {
			Ok(stat) => Ok(Some(stat)),
			Err(libc::ENOENT) => Ok(None),
			Err(error) => Err(errno_error(error, true)),
		}
	}

	fn revision_at(parent: RawFd, name: &CStr, cap: usize) -> Result<Option<(String, Signature)>> {
		let stat = target_stat(parent, name)?.ok_or_else(|| native_error(ErrorCode::NotFound))?;
		if !regular(&stat) {
			if (stat.st_mode & libc::S_IFMT) == libc::S_IFLNK {
				return Err(native_error(ErrorCode::UnsafePath));
			}
			return Err(native_error(ErrorCode::NotFile));
		}
		let fd = open_target(parent, name)?;
		let (revision, fd_signature) = hash_file_fd(fd.0, cap)?;
		if signature(&stat) != fd_signature {
			return Err(native_error(ErrorCode::Conflict));
		}
		Ok(Some((revision, fd_signature)))
	}

	pub fn read(root: &str, path: &str, max_bytes: u64) -> Result<SecureReadFileResult> {
		let cap = validate_limits(max_bytes)?;
		let components = parse_path(path, false)?;
		let root = Fd::open_root(root)?;
		let parent = traverse_parent(&root, &components[..components.len() - 1])?;
		let leaf = components.last().expect("non-empty path");
		let fd = open_target(parent.0, leaf.as_c_str())?;
		let (bytes, _signature, revision_sha256) = read_file_fd(fd.0, cap)?;
		Ok(SecureReadFileResult {
			size: u32::try_from(bytes.len()).map_err(|_| native_error(ErrorCode::Bounds))?,
			data: Buffer::from(bytes),
			revision_sha256,
		})
	}

	pub fn list(
		root: &str,
		path: Option<&str>,
		max_entries: u64,
	) -> Result<SecureListDirectoryResult> {
		let cap = validate_entries(max_entries)?;
		let components = parse_path(path.unwrap_or(""), true)?;
		let root = Fd::open_root(root)?;
		let directory_fd = traverse_parent(&root, &components)?;
		let duplicate = directory_fd.duplicate()?;
		let raw = duplicate.0;
		std::mem::forget(duplicate);
		// SAFETY: raw is a duplicate fd and fdopendir assumes ownership of it.
		let directory = unsafe { libc::fdopendir(raw) };
		if directory.is_null() {
			// SAFETY: raw is the duplicate fd not transferred to fdopendir after failure.
			let _ = unsafe { libc::close(raw) };
			return Err(native_error(ErrorCode::Io));
		}
		let directory = Directory(directory);
		let prefix = path.unwrap_or("");
		let mut entries = Vec::with_capacity(cap.min(256));
		loop {
			// SAFETY: directory is a valid DIR pointer owned by the guard.
			clear_errno();
			// SAFETY: directory is a valid DIR pointer owned by the guard.
			let entry = unsafe { libc::readdir(directory.0) };
			if entry.is_null() {
				let error = errno();
				if error != 0 && error != libc::ENOENT {
					return Err(native_error(ErrorCode::Io));
				}
				break;
			}
			// SAFETY: d_name is a NUL-terminated array owned by readdir.
			let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
			if name.to_bytes() == b"." || name.to_bytes() == b".." {
				continue;
			}
			if entries.len() >= cap {
				return Err(native_error(ErrorCode::Bounds));
			}
			let stat = fstatat(directory_fd.0, name).map_err(|error| errno_error(error, true))?;
			let name_bytes = name.to_bytes();
			let name_string = std::str::from_utf8(name_bytes)
				.map_err(|_| native_error(ErrorCode::Io))?
				.to_owned();
			let entry_path = if prefix.is_empty() {
				name_string.clone()
			} else {
				format!("{prefix}/{name_string}")
			};
			entries.push(SecureDirectoryEntry {
				name: name_string,
				path: entry_path,
				kind: mode_kind(&stat).to_owned(),
				size: regular(&stat).then_some(signature(&stat).size as f64),
			});
		}
		entries.sort_unstable_by(|left, right| left.name.cmp(&right.name));
		entries.dedup_by(|left, right| left.name == right.name);
		Ok(SecureListDirectoryResult { entries })
	}

	pub fn write(
		root: &str,
		path: &str,
		data: &[u8],
		expected_revision: Option<&str>,
		max_bytes: u64,
	) -> Result<SecureWriteFileResult> {
		let cap = validate_limits(max_bytes)?;
		if data.len() > cap {
			return Err(native_error(ErrorCode::Bounds));
		}
		validate_revision(expected_revision)?;
		let components = parse_path(path, false)?;
		let root = Fd::open_root(root)?;
		let parent = traverse_parent(&root, &components[..components.len() - 1])?;
		let leaf = components.last().expect("non-empty path");
		let _guard = SECURE_WRITE_LOCK
			.lock()
			.map_err(|_| native_error(ErrorCode::Io))?;

		if let Some(expected) = expected_revision {
			let initial = revision_at(parent.0, leaf.as_c_str(), cap)?;
			match initial {
				Some((actual, _)) if actual == expected => {},
				Some(_) => return Err(native_error(ErrorCode::Conflict)),
				None => return Err(native_error(ErrorCode::NotFound)),
			}
		} else if let Some(stat) = target_stat(parent.0, leaf.as_c_str())? {
			if (stat.st_mode & libc::S_IFMT) == libc::S_IFLNK {
				return Err(native_error(ErrorCode::UnsafePath));
			}
			return Err(if regular(&stat) {
				native_error(ErrorCode::Conflict)
			} else {
				native_error(ErrorCode::NotFile)
			});
		}

		let mut temp = create_temp(parent.0)?;
		let temp_fd = temp.fd.as_ref().expect("new temp has fd").0;
		write_all(temp_fd, data).and_then(|()| fsync(temp_fd))?;
		drop(temp.fd.take());

		if let Some(expected) = expected_revision {
			let current = revision_at(parent.0, leaf.as_c_str(), cap)?;
			match current {
				Some((actual, _)) if actual == expected => {},
				Some(_) => return Err(native_error(ErrorCode::Conflict)),
				None => return Err(native_error(ErrorCode::Conflict)),
			}
		}
		install_temp(parent.0, temp.name.as_c_str(), leaf.as_c_str(), expected_revision.is_some())?;
		temp.disarm();
		fsync(parent.0)?;
		let mut hash = Sha256::new();
		hash.update(data);
		Ok(SecureWriteFileResult {
			size:            u32::try_from(data.len()).map_err(|_| native_error(ErrorCode::Bounds))?,
			revision_sha256: hash.finish(),
		})
	}

	// Small, allocation-free SHA-256 implementation used so the native addon
	// does not need another package/lock dependency. State is updated per read
	// chunk and only the final 32-byte digest is materialized.
	pub(super) struct Sha256 {
		state:      [u32; 8],
		buffer:     [u8; 64],
		buffer_len: usize,
		length:     u64,
	}

	impl Sha256 {
		pub(super) const fn new() -> Self {
			Self {
				state:      [
					0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
					0x5be0cd19,
				],
				buffer:     [0; 64],
				buffer_len: 0,
				length:     0,
			}
		}

		pub(super) fn update(&mut self, mut bytes: &[u8]) {
			self.length = self.length.saturating_add(bytes.len() as u64);
			if self.buffer_len != 0 {
				let count = (64 - self.buffer_len).min(bytes.len());
				self.buffer[self.buffer_len..self.buffer_len + count].copy_from_slice(&bytes[..count]);
				self.buffer_len += count;
				bytes = &bytes[count..];
				if self.buffer_len == 64 {
					let block = self.buffer;
					self.compress(&block);
					self.buffer_len = 0;
				}
			}
			while bytes.len() >= 64 {
				self.compress(&bytes[..64]);
				bytes = &bytes[64..];
			}
			if !bytes.is_empty() {
				self.buffer[..bytes.len()].copy_from_slice(bytes);
				self.buffer_len = bytes.len();
			}
		}

		pub(super) fn finish(mut self) -> String {
			let bit_length = self.length.saturating_mul(8);
			self.buffer[self.buffer_len] = 0x80;
			self.buffer_len += 1;
			if self.buffer_len > 56 {
				self.buffer[self.buffer_len..].fill(0);
				let block = self.buffer;
				self.compress(&block);
				self.buffer_len = 0;
			}
			self.buffer[self.buffer_len..56].fill(0);
			self.buffer[56..].copy_from_slice(&bit_length.to_be_bytes());
			let block = self.buffer;
			self.compress(&block);
			let mut output = String::with_capacity(64);
			for word in self.state {
				let _ = write!(output, "{word:08x}");
			}
			output
		}

		#[allow(
			clippy::many_single_char_names,
			reason = "SHA-256 round notation follows the standard"
		)]
		fn compress(&mut self, block: &[u8]) {
			const K: [u32; 64] = [
				0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
				0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
				0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
				0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
				0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
				0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
				0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
				0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
				0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
				0xc67178f2,
			];
			let mut words = [0u32; 64];
			for index in 0..16 {
				words[index] = u32::from_be_bytes([
					block[index * 4],
					block[index * 4 + 1],
					block[index * 4 + 2],
					block[index * 4 + 3],
				]);
			}
			for index in 16..64 {
				let x = words[index - 15].rotate_right(7)
					^ words[index - 15].rotate_right(18)
					^ (words[index - 15] >> 3);
				let y = words[index - 2].rotate_right(17)
					^ words[index - 2].rotate_right(19)
					^ (words[index - 2] >> 10);
				words[index] = words[index - 16]
					.wrapping_add(x)
					.wrapping_add(words[index - 7])
					.wrapping_add(y);
			}
			let mut a = self.state[0];
			let mut b = self.state[1];
			let mut c = self.state[2];
			let mut d = self.state[3];
			let mut e = self.state[4];
			let mut f = self.state[5];
			let mut g = self.state[6];
			let mut h = self.state[7];
			for index in 0..64 {
				let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
				let choose = (e & f) ^ ((!e) & g);
				let temp1 = h
					.wrapping_add(s1)
					.wrapping_add(choose)
					.wrapping_add(K[index])
					.wrapping_add(words[index]);
				let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
				let majority = (a & b) ^ (a & c) ^ (b & c);
				let temp2 = s0.wrapping_add(majority);
				h = g;
				g = f;
				f = e;
				e = d.wrapping_add(temp1);
				d = c;
				c = b;
				b = a;
				a = temp1.wrapping_add(temp2);
			}
			self.state[0] = self.state[0].wrapping_add(a);
			self.state[1] = self.state[1].wrapping_add(b);
			self.state[2] = self.state[2].wrapping_add(c);
			self.state[3] = self.state[3].wrapping_add(d);
			self.state[4] = self.state[4].wrapping_add(e);
			self.state[5] = self.state[5].wrapping_add(f);
			self.state[6] = self.state[6].wrapping_add(g);
			self.state[7] = self.state[7].wrapping_add(h);
		}
	}
}

#[cfg(not(unix))]
mod unix {
	use super::*;

	pub fn read(_root: &str, _path: &str, _max_bytes: u64) -> Result<SecureReadFileResult> {
		Err(native_error(ErrorCode::Unsupported))
	}

	pub fn list(
		_root: &str,
		_path: Option<&str>,
		_max_entries: u64,
	) -> Result<SecureListDirectoryResult> {
		Err(native_error(ErrorCode::Unsupported))
	}

	pub fn write(
		_root: &str,
		_path: &str,
		_data: &[u8],
		_expected_revision: Option<&str>,
		_max_bytes: u64,
	) -> Result<SecureWriteFileResult> {
		Err(native_error(ErrorCode::Unsupported))
	}
}

/// Read one regular file beneath `root` without following symlinks.
#[napi(js_name = "secureReadFile")]
pub fn secure_read_file(
	root: String,
	relative_path: String,
	max_bytes: u32,
) -> Result<SecureReadFileResult> {
	unix::read(&root, &relative_path, u64::from(max_bytes))
}

/// List a directory beneath `root`, sorted by entry name.
#[napi(js_name = "secureListDirectory")]
pub fn secure_list_directory(
	root: String,
	relative_path: Option<String>,
	max_entries: u32,
) -> Result<SecureListDirectoryResult> {
	unix::list(&root, relative_path.as_deref(), u64::from(max_entries))
}

/// Atomically create or replace one regular file beneath `root`.
#[napi(js_name = "secureWriteFileAtomic")]
pub fn secure_write_file_atomic(
	root: String,
	relative_path: String,
	data: Buffer,
	expected_revision: Option<String>,
	max_bytes: u32,
) -> Result<SecureWriteFileResult> {
	unix::write(
		&root,
		&relative_path,
		data.as_ref(),
		expected_revision.as_deref(),
		u64::from(max_bytes),
	)
}

#[cfg(test)]
mod tests {
	use super::unix::Sha256;

	#[test]
	fn sha256_vectors() {
		let mut hash = Sha256::new();
		hash.update(b"");
		assert_eq!(hash.finish(), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
		let mut hash = Sha256::new();
		hash.update(b"abc");
		assert_eq!(hash.finish(), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	}
	#[cfg(unix)]
	#[test]
	fn jail_read_list_and_atomic_revisions() {
		use std::{
			fs,
			os::unix::fs::PermissionsExt,
			time::{SystemTime, UNIX_EPOCH},
		};

		let suffix = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.expect("clock")
			.as_nanos();
		let root = std::env::temp_dir().join(format!("omp-secure-fs-{suffix}"));
		fs::create_dir(&root).expect("root");
		fs::create_dir(root.join("nested")).expect("nested");
		let root_string = root.to_str().expect("utf8 root");

		let created =
			super::unix::write(root_string, "nested/blob", b"\0binary", None, 1024).expect("create");
		assert_eq!(created.size, 7);
		let read = super::unix::read(root_string, "nested/blob", 1024).expect("read");
		assert_eq!(read.data.as_ref(), b"\0binary");
		assert_eq!(read.size, 7);
		let listed = super::unix::list(root_string, Some("nested"), 10).expect("list");
		assert_eq!(listed.entries.len(), 1);
		assert_eq!(listed.entries[0].name, "blob");
		assert_eq!(listed.entries[0].path, "nested/blob");
		assert_eq!(listed.entries[0].kind, "file");
		assert_eq!(
			fs::metadata(root.join("nested/blob"))
				.expect("metadata")
				.permissions()
				.mode() & 0o777,
			0o600
		);

		assert!(super::unix::write(root_string, "nested/blob", b"new", None, 1024).is_err());
		let replaced = super::unix::write(
			root_string,
			"nested/blob",
			b"new",
			Some(&created.revision_sha256),
			1024,
		)
		.expect("replace");
		assert_eq!(replaced.size, 3);
		assert!(
			super::unix::write(
				root_string,
				"nested/blob",
				b"stale",
				Some(&created.revision_sha256),
				1024
			)
			.is_err()
		);

		#[cfg(target_os = "linux")]
		std::os::unix::fs::symlink("nested/blob", root.join("link")).expect("symlink");
		#[cfg(target_os = "linux")]
		assert!(super::unix::read(root_string, "link", 1024).is_err());

		fs::remove_dir_all(root).expect("cleanup");
	}
	#[cfg(unix)]
	#[test]
	fn stale_errno_does_not_poison_list_eof() {
		use std::{
			fs,
			time::{SystemTime, UNIX_EPOCH},
		};
		let suffix = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.expect("clock")
			.as_nanos();
		let root = std::env::temp_dir().join(format!("omp-secure-errno-{suffix}"));
		fs::create_dir(&root).expect("root");
		fs::write(root.join("notdir"), b"x").expect("file");
		let root_string = root.to_str().expect("utf8 root");
		assert!(super::unix::read(root_string, "notdir/x", 1024).is_err());
		assert!(super::unix::list(root_string, None, 10).is_ok());
		fs::remove_dir_all(root).expect("cleanup");
	}

	#[cfg(unix)]
	#[test]
	fn in_process_revision_race_has_one_winner() {
		use std::{
			fs,
			sync::{Arc, Barrier},
			thread,
			time::{SystemTime, UNIX_EPOCH},
		};
		let suffix = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.expect("clock")
			.as_nanos();
		let root = std::env::temp_dir().join(format!("omp-secure-race-{suffix}"));
		fs::create_dir(&root).expect("root");
		let root_string = root.to_str().expect("utf8 root").to_owned();
		let initial = super::unix::write(&root_string, "race", &[7], None, 1024).expect("initial");
		let expected = initial.revision_sha256;
		let root = Arc::new(root_string);
		let barrier = Arc::new(Barrier::new(2));
		#[allow(clippy::needless_collect, reason = "collect keeps both racers alive before joining")]
		let handles = (0..2)
			.map(|index| {
				let root = Arc::clone(&root);
				let barrier = Arc::clone(&barrier);
				let expected = expected.clone();
				thread::spawn(move || {
					barrier.wait();
					super::unix::write(&root, "race", &[index], Some(&expected), 1024)
				})
			})
			.collect::<Vec<_>>();
		#[allow(
			clippy::needless_collect,
			reason = "collect stores both outcomes for deterministic assertions"
		)]
		let outcomes = handles
			.into_iter()
			.map(|handle| handle.join().expect("join"))
			.collect::<Vec<_>>();
		assert_eq!(outcomes.iter().filter(|result| result.is_ok()).count(), 1);
		assert_eq!(outcomes.iter().filter(|result| result.is_err()).count(), 1);
		let winner = outcomes
			.iter()
			.find_map(|result| result.as_ref().ok())
			.expect("winner");
		let read = super::unix::read(&root, "race", 1024).expect("read winner");
		assert_eq!(read.revision_sha256, winner.revision_sha256);
		fs::remove_dir_all(root.as_str()).expect("cleanup");
	}
}
